import type { RemoteAccessMode, RemoteAccessSnapshot } from '../../shared/remote-control'
import { setRemoteAccessMode } from './authorization-state'

/**
 * The main process is the single authority for "how much remote access this
 * machine currently grants". Two things depend on it:
 *
 *  - the renderer, which shows a persistent indicator and drives the settings
 *    control;
 *  - the approval chain, which may skip a human for tool calls raised by a run
 *    that belongs to a live unattended session.
 *
 * Automatic approval is deliberately narrow: it requires the durable permission
 * to be `unattended`, a live inbound session, and a run that was submitted
 * while that session was already open. A run started before the session (or by
 * the local user afterwards) never qualifies, so nobody can inherit a decision
 * they did not make.
 */

const AUTO_APPROVAL_LIMIT = 200
const AUTO_APPROVAL_WINDOW_MS = 12 * 60 * 60 * 1000

let accessMode: RemoteAccessMode = 'none'
let activeSessionId: string | null = null
let approvalTimestamps: number[] = []
/** runId → sessionId for runs submitted while a control session was open. */
const runSessions = new Map<string, string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function currentAccessMode(): RemoteAccessMode {
  return accessMode
}

export function accessSnapshot(): RemoteAccessSnapshot {
  pruneApprovalWindow()
  return {
    mode: accessMode,
    sessionId: activeSessionId,
    autoApprovalsUsed: approvalTimestamps.length,
    autoApprovalsLimit: AUTO_APPROVAL_LIMIT
  }
}

export function subscribeAccessMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Applies a mode coming from the control plane (GET/PUT remote-access or a
 * heartbeat echo). Dropping to `none` also tears down the live session so a
 * revoke takes effect immediately rather than at the next signalling frame.
 */
export function applyAccessMode(next: RemoteAccessMode): void {
  const changed = next !== accessMode
  accessMode = next
  if (next === 'none') {
    activeSessionId = null
    runSessions.clear()
  }
  setRemoteAccessMode(next)
  if (changed) notify()
}

/** Records the live inbound control session and re-arms automatic approval. */
export function beginRemoteSession(sessionId: string): void {
  if (!sessionId) return
  if (activeSessionId !== sessionId) {
    runSessions.clear()
    activeSessionId = sessionId
    notify()
  }
}

export function endRemoteSession(sessionId?: string | null): void {
  if (sessionId && activeSessionId && sessionId !== activeSessionId) return
  if (activeSessionId === null && runSessions.size === 0) return
  activeSessionId = null
  runSessions.clear()
  notify()
}

export function activeRemoteSessionId(): string | null {
  return activeSessionId
}

/**
 * Binds a freshly submitted run to the live session. Returns the session id the
 * run belongs to, or null when no session was open at submit time — that null
 * is what keeps local runs out of the automatic-approval path.
 */
export function bindRunToSession(runId: string): string | null {
  if (!runId) return null
  if (!activeSessionId || accessMode === 'none') {
    runSessions.delete(runId)
    return null
  }
  runSessions.set(runId, activeSessionId)
  // Keep the map bounded; the oldest run is the one least likely to ask again.
  if (runSessions.size > 512) {
    const oldest = runSessions.keys().next()
    if (!oldest.done) runSessions.delete(oldest.value)
  }
  return activeSessionId
}

export function forgetRun(runId: string): void {
  runSessions.delete(runId)
}

export type TaskAdmissionDecision =
  | { admitted: true; sessionId: string; automatic: boolean }
  | {
      admitted: false
      reason: 'access-disabled' | 'session-busy' | 'confirmation-required' | 'quota-exhausted'
    }

/**
 * Admits one inbound Mesh task. `confirmed` is the local user's explicit yes;
 * without it only an unattended machine may admit, and admission spends one
 * unit of the same quota a tool approval would, so a peer cannot open runs
 * without limit.
 *
 * A live session belonging to somebody else is never replaced. Replacing it
 * would clear its run bindings and silently withdraw approvals the local user
 * is still relying on, which is a worse outcome than refusing the task.
 *
 * This is independent of remote input: admitting a task grants no pointer or
 * keyboard authority, and an authorized input session grants no task admission.
 */
export function admitRemoteTask(sessionId: string, confirmed: boolean): TaskAdmissionDecision {
  if (!sessionId || accessMode === 'none') return { admitted: false, reason: 'access-disabled' }
  if (activeSessionId && activeSessionId !== sessionId) {
    return { admitted: false, reason: 'session-busy' }
  }
  if (!confirmed) {
    if (accessMode !== 'unattended') return { admitted: false, reason: 'confirmation-required' }
    pruneApprovalWindow()
    if (approvalTimestamps.length >= AUTO_APPROVAL_LIMIT) {
      return { admitted: false, reason: 'quota-exhausted' }
    }
    approvalTimestamps.push(Date.now())
  }
  beginRemoteSession(sessionId)
  notify()
  return { admitted: true, sessionId, automatic: !confirmed }
}

function pruneApprovalWindow(): void {
  const cutoff = Date.now() - AUTO_APPROVAL_WINDOW_MS
  approvalTimestamps = approvalTimestamps.filter((timestamp) => timestamp > cutoff)
}

export type AutoApprovalDecision =
  | { approved: true; sessionId: string }
  | {
      approved: false
      reason: 'not-unattended' | 'no-session' | 'run-not-bound' | 'quota-exhausted'
    }

/**
 * Decides one tool approval on behalf of an absent user. Failure is the default:
 * every guard must pass before a decision is delegated to the session.
 */
export function requestAutoApproval(runId: string): AutoApprovalDecision {
  if (accessMode !== 'unattended') return { approved: false, reason: 'not-unattended' }
  if (!activeSessionId) return { approved: false, reason: 'no-session' }
  const boundSession = runSessions.get(runId)
  if (!boundSession || boundSession !== activeSessionId) {
    return { approved: false, reason: 'run-not-bound' }
  }
  pruneApprovalWindow()
  if (approvalTimestamps.length >= AUTO_APPROVAL_LIMIT) {
    return { approved: false, reason: 'quota-exhausted' }
  }
  approvalTimestamps.push(Date.now())
  notify()
  return { approved: true, sessionId: activeSessionId }
}
