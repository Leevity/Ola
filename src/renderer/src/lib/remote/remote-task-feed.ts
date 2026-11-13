import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'
import type { RemoteTaskSnapshot } from '../../../../shared/remote-control'
import { setRemoteTaskPublisher } from './remote-task-progress'

/**
 * Publishes the local task projection to the control plane.
 *
 * The console does not have to open a screen session to know what a machine is
 * doing: it reads this feed instead. That is the difference between "watch my
 * desktop like ToDesk" and "follow the terminal work I asked for" — the second
 * needs no video, no ICE and no input channel, so it also works while nobody is
 * allowed to control the machine's screen.
 *
 * Reporting is best-effort by design. A dropped frame means the console shows
 * slightly older progress; it must never mean the task itself was disturbed.
 */

/** Reports are coalesced: an agent loop emits far more events than a table needs. */
const MIN_INTERVAL_MS = 1500

export type RemoteTaskFeedConfig = {
  apiBaseUrl: string
  deviceId: string
  /** Only true while the owner has allowed remote access; "none" reports nothing. */
  enabled: boolean
}

let config: RemoteTaskFeedConfig | null = null
let queued: RemoteTaskSnapshot | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let sending = false
let lastSentAt = 0

function keyOf(next: RemoteTaskFeedConfig | null): string {
  return next ? `${next.apiBaseUrl}|${next.deviceId}|${next.enabled ? '1' : '0'}` : ''
}

/**
 * Points the feed at a control plane. Reconfiguring drops anything queued: it
 * belongs to the previous server or the previous device and would otherwise be
 * delivered to the wrong place.
 */
export function configureRemoteTaskFeed(next: RemoteTaskFeedConfig | null): void {
  if (keyOf(next) === keyOf(config)) return
  config = next
  queued = null
  if (timer !== null) {
    globalThis.clearTimeout(timer)
    timer = null
  }
  lastSentAt = 0
}

function payloadOf(snapshot: RemoteTaskSnapshot): Record<string, unknown> {
  return {
    runId: snapshot.runId,
    ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
    status: snapshot.status,
    title: snapshot.title,
    ...(snapshot.workingDirectory ? { workingDirectory: snapshot.workingDirectory } : {}),
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    text: snapshot.text,
    seq: snapshot.seq,
    done: snapshot.done,
    steps: snapshot.steps.map((step) => ({
      id: step.id,
      name: step.name,
      status: step.status,
      startedAt: step.startedAt,
      ...(step.finishedAt ? { finishedAt: step.finishedAt } : {}),
      ...(step.summary ? { summary: step.summary } : {}),
      ...(step.output ? { output: step.output } : {})
    }))
  }
}

async function deliver(snapshot: RemoteTaskSnapshot, target: RemoteTaskFeedConfig): Promise<void> {
  try {
    await ipcClient.invoke(IPC.REMOTE_ACCOUNT_INVOKE, {
      apiBaseUrl: target.apiBaseUrl,
      operation: 'device-task-publish',
      payload: { deviceId: target.deviceId, task: payloadOf(snapshot) }
    })
  } catch {
    // The next flush retries with fresher data; a queue of stale frames would
    // only make the console jump backwards.
  }
}

function sendQueued(): void {
  if (sending || !queued || !config?.enabled) return
  const snapshot = queued
  const target = config
  queued = null
  sending = true
  lastSentAt = Date.now()
  void deliver(snapshot, target).finally(() => {
    sending = false
    // A frame arrived while this one was in flight: schedule it rather than
    // dropping it, otherwise the panel would freeze on the sent state.
    if (queued && timer === null) schedule()
  })
}

function schedule(): void {
  if (timer !== null) return
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastSentAt))
  timer = globalThis.setTimeout(() => {
    timer = null
    sendQueued()
  }, wait)
}

/** Reports one frame. Terminal frames skip the throttle: they are the answer. */
export function publishRemoteTaskFeed(snapshot: RemoteTaskSnapshot): void {
  if (!config?.enabled) return
  queued = snapshot
  if (snapshot.done) {
    if (timer !== null) {
      globalThis.clearTimeout(timer)
      timer = null
    }
    sendQueued()
    return
  }
  schedule()
}

// The projection module stays transport-agnostic; it is wired here because
// this module owns the lifecycle of the control-plane connection.
setRemoteTaskPublisher((snapshot) => publishRemoteTaskFeed(snapshot))
