import type { RemoteMeshTask, RemoteTaskDecision } from '../../shared/remote-control'
import {
  admitRemoteTask,
  currentAccessMode,
  endRemoteSession,
  subscribeAccessMode
} from './access-mode'
import type { MeshTaskReceiptDelivery } from './mesh-events'

/**
 * The main-process inbox for inbound Mesh tasks.
 *
 * Only `recordVerifiedMeshTask` writes a new entry, and its sole caller has
 * already verified the Ed25519 envelope and the `task.execute` capability
 * ticket. That is what makes the renderer's accept button safe to honour: the
 * renderer chooses among tasks this process authenticated, it cannot introduce
 * one.
 *
 * Admission is separate from execution. `admitted` means the access mode and
 * the quota allowed the task; a renderer still has to claim it before a run
 * exists, so two windows cannot both execute the same request.
 */

/** How long an unclaimed request stays answerable. Past this it is expired. */
const PENDING_TTL_MS = 10 * 60 * 1000
const MAX_TASKS = 64

export type MeshTaskReceiptState = 'started' | 'completed' | 'failed' | 'rejected' | 'expired'

export type MeshTaskReceiptRequest = {
  targetNodeId: string
  sessionId: string
  taskId: string
  state: MeshTaskReceiptState
  sequence: number
  resultText?: string
}

type TaskEntry = RemoteMeshTask & { runId: string | null; receiptSequence: number }

const tasks = new Map<string, TaskEntry>()

/**
 * The transport registers itself here rather than being imported, so this
 * module stays free of network dependencies and cannot form a cycle with the
 * account client that feeds it.
 */
let publisher: ((receipt: MeshTaskReceiptRequest) => void) | null = null

export function setMeshTaskReceiptPublisher(
  next: ((receipt: MeshTaskReceiptRequest) => void) | null
): void {
  publisher = next
}

function report(entry: TaskEntry, state: MeshTaskReceiptState, resultText?: string): void {
  entry.receiptSequence += 1
  if (!publisher) return
  try {
    publisher({
      targetNodeId: entry.sourceNodeId,
      sessionId: entry.sessionId,
      taskId: entry.taskId,
      state,
      sequence: entry.receiptSequence,
      // The receipt verifier only accepts result text on a completed task.
      ...(state === 'completed' && resultText ? { resultText } : {})
    })
  } catch {
    // A receipt is advisory: failing to send one must not undo a local decision.
  }
}

function expire(entry: TaskEntry): void {
  entry.status = 'expired'
  report(entry, 'expired')
}

function prune(now: number): void {
  for (const entry of tasks.values()) {
    if (
      (entry.status === 'pending' || entry.status === 'admitted') &&
      now - entry.receivedAt > PENDING_TTL_MS
    ) {
      expire(entry)
    }
  }
  // Decided entries are kept so a re-delivered event cannot be admitted twice.
  // The capability ticket's own expiry is the outer bound on replay; this cap
  // only stops a long-lived process from growing without limit.
  while (tasks.size > MAX_TASKS) {
    const oldest = tasks.keys().next()
    if (oldest.done) break
    tasks.delete(oldest.value)
  }
}

function project(entry: TaskEntry): RemoteMeshTask {
  return {
    taskId: entry.taskId,
    sessionId: entry.sessionId,
    sourceNodeId: entry.sourceNodeId,
    text: entry.text,
    receivedAt: entry.receivedAt,
    status: entry.status
  }
}

/**
 * Records a delivery whose signature and ticket already verified. Re-delivery
 * of the same task id returns the existing entry untouched, so a replayed
 * event can neither reset a rejection nor spend a second admission.
 */
export function recordVerifiedMeshTask(delivery: MeshTaskReceiptDelivery): RemoteMeshTask {
  const now = Date.now()
  prune(now)
  const taskId = String(delivery.payload.task_id)
  const existing = tasks.get(taskId)
  if (existing) return project(existing)
  const entry: TaskEntry = {
    taskId,
    sessionId: delivery.sessionId,
    sourceNodeId: delivery.subjectNodeId,
    text: String(delivery.payload.task_text),
    receivedAt: now,
    status: 'pending',
    runId: null,
    receiptSequence: 0
  }
  tasks.set(taskId, entry)
  // Nobody is watching an unattended machine, so the decision is made here
  // rather than waiting for a confirmation that will never come. A refusal is
  // recorded as a rejection so the peer gets an answer instead of silence.
  if (currentAccessMode() === 'unattended') {
    const admission = admitRemoteTask(entry.sessionId, false)
    if (admission.admitted) {
      entry.status = 'admitted'
    } else {
      entry.status = 'rejected'
      report(entry, 'rejected')
    }
  }
  return project(entry)
}

export function listRemoteMeshTasks(): RemoteMeshTask[] {
  prune(Date.now())
  return [...tasks.values()].map(project)
}

export function getRemoteMeshTask(taskId: string): RemoteMeshTask | null {
  prune(Date.now())
  const entry = tasks.get(taskId)
  return entry ? project(entry) : null
}

/**
 * The local user's answer to a pending request. `accept` is the confirmation
 * attended mode requires; without it the call can only reject.
 */
export function decideRemoteMeshTask(taskId: string, accept: boolean): RemoteTaskDecision {
  prune(Date.now())
  const entry = tasks.get(taskId)
  if (!entry) return { accepted: false, taskId, reason: 'unknown-task' }
  if (entry.status !== 'pending') return { accepted: false, taskId, reason: 'already-decided' }
  if (!accept) {
    entry.status = 'rejected'
    report(entry, 'rejected')
    return { accepted: false, taskId, reason: 'user-rejected' }
  }
  const admission = admitRemoteTask(entry.sessionId, true)
  if (!admission.admitted) return { accepted: false, taskId, reason: admission.reason }
  entry.status = 'admitted'
  return { accepted: true, taskId, sessionId: entry.sessionId, automatic: false }
}

/**
 * Claims an admitted task for execution. Fails closed for anything that is not
 * admitted, which is what stops a second window from running the same request.
 */
export function startRemoteMeshTask(taskId: string, runId: string): { success: boolean } {
  prune(Date.now())
  const entry = tasks.get(taskId)
  if (!entry || entry.status !== 'admitted' || !runId) return { success: false }
  entry.status = 'running'
  entry.runId = runId
  report(entry, 'started')
  return { success: true }
}

/**
 * Closes a task and releases the session it opened. The session is only ended
 * when it is still the active one, so a control session that started afterwards
 * is not torn down by a finishing task.
 */
export function finishRemoteMeshTask(
  taskId: string,
  outcome: 'completed' | 'failed',
  resultText?: string
): { success: boolean } {
  prune(Date.now())
  const entry = tasks.get(taskId)
  if (!entry || (entry.status !== 'running' && entry.status !== 'admitted')) {
    return { success: false }
  }
  entry.status = outcome
  report(entry, outcome, resultText)
  endRemoteSession(entry.sessionId)
  return { success: true }
}

/** Test seam: drops every entry so suites do not inherit each other's tasks. */
export function resetRemoteMeshTasks(): void {
  tasks.clear()
}

// Withdrawing remote access must also withdraw the inbox: a request that was
// waiting for an answer no longer has one. A task already running is local work
// by then and is left alone; its automatic approvals stop with the session.
subscribeAccessMode(() => {
  if (currentAccessMode() !== 'none') return
  for (const entry of tasks.values()) {
    if (entry.status === 'pending' || entry.status === 'admitted') expire(entry)
  }
})
