import type { RunEvent } from '../../../../shared/runtime/contracts'
import type {
  RemoteTaskSnapshot,
  RemoteTaskStatus,
  RemoteTaskStep
} from '../../../../shared/remote-control'

/**
 * Projects the run this machine is executing into something a controller can
 * read over the peer channel.
 *
 * The projection is intentionally lossy: a controller needs "what is it doing
 * now", not a replayable journal. Deltas arrive far faster than a peer channel
 * or a remote operator can consume, so text and steps are coalesced and the
 * snapshot is pushed on a timer instead of per event.
 */

const PUSH_INTERVAL_MS = 300
const TEXT_LIMIT = 4000
const STEP_OUTPUT_LIMIT = 900
const STEP_SUMMARY_LIMIT = 300
const MAX_STEPS = 40
/**
 * How soon after a run ends the next run on the same prompt is still the same
 * task. The agent loop submits one run per turn back to back, and a turn can
 * spend minutes in tools, so the window is generous: wiping the steps in the
 * middle of one logical task is far worse than inheriting them when an operator
 * deliberately re-sends the same prompt.
 */
const CONTINUATION_WINDOW_MS = 5 * 60_000

type MutableTask = {
  runId: string
  /** Session the task belongs to; successive turns share one session. */
  sessionId: string | null
  status: RemoteTaskStatus
  title: string
  /** Directory the run works in, shown next to the steps like a shell prompt. */
  workingDirectory: string
  startedAt: number
  text: string
  steps: RemoteTaskStep[]
  seq: number
  updatedAt: number
  done: boolean
  /** When the run reached a terminal status, used to recognise its next turn. */
  finishedAt: number | null
}

let current: MutableTask | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null
let dirty = false

/**
 * The peer store registers its channel writer here instead of being imported,
 * so this module stays free of store dependencies and cannot form a cycle with
 * the transport it reports over.
 */
let sender: ((snapshot: RemoteTaskSnapshot) => void) | null = null

/**
 * Second sink: the control plane. A screen session is one way to watch a
 * machine work, but it is not the only one an operator wants — the console can
 * follow a task with no session at all, which is what this publisher feeds.
 * Both sinks are optional and independent; a task runs the same locally whether
 * or not anybody is listening.
 */
let publisher: ((snapshot: RemoteTaskSnapshot) => void) | null = null

export function setRemoteTaskSender(next: ((snapshot: RemoteTaskSnapshot) => void) | null): void {
  sender = next
}

export function setRemoteTaskPublisher(
  next: ((snapshot: RemoteTaskSnapshot) => void) | null
): void {
  publisher = next
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function oneLine(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** Arguments are digested to a short hint; a controller never sees raw payloads. */
function summarizeInput(input: unknown): string {
  const item = record(input)
  if (!item) return ''
  const preferred = ['path', 'file_path', 'command', 'query', 'url', 'pattern', 'name', 'prompt']
  for (const key of preferred) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) return oneLine(value, STEP_SUMMARY_LIMIT)
  }
  const keys = Object.keys(item)
  return keys.length ? oneLine(keys.join(', '), STEP_SUMMARY_LIMIT) : ''
}

/**
 * Some tools state the directory they ran in. When the chat session has no
 * folder of its own, that is the only honest answer to "where is this
 * happening", so it is adopted rather than left blank.
 */
function directoryFromInput(input: unknown): string {
  const item = record(input)
  if (!item) return ''
  for (const key of ['cwd', 'workingDirectory', 'working_dir', 'workingFolder']) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) return oneLine(value, 300)
  }
  return ''
}

function summarizeOutput(output: unknown): string {
  const text =
    typeof output === 'string'
      ? output
      : (() => {
          try {
            return JSON.stringify(output)
          } catch {
            return ''
          }
        })()
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > STEP_OUTPUT_LIMIT ? `${flat.slice(0, STEP_OUTPUT_LIMIT - 1)}…` : flat
}

function terminalStatus(value: string): RemoteTaskStatus | null {
  if (value === 'completed') return 'completed'
  if (value === 'failed') return 'failed'
  if (value === 'cancelled') return 'cancelled'
  if (value === 'interrupted') return 'interrupted'
  return null
}

function snapshot(): RemoteTaskSnapshot | null {
  if (!current) return null
  return {
    runId: current.runId,
    sessionId: current.sessionId,
    status: current.status,
    title: current.title,
    ...(current.workingDirectory ? { workingDirectory: current.workingDirectory } : {}),
    startedAt: current.startedAt,
    text: current.text,
    steps: current.steps.map((step) => ({ ...step })),
    seq: current.seq,
    updatedAt: current.updatedAt,
    done: current.done
  }
}

/**
 * Pushes the current projection. A closed or absent peer channel simply drops
 * the frame: the next open session starts from a fresh snapshot, so there is
 * nothing to queue for a controller that is not there yet.
 */
function push(): void {
  pushTimer = null
  if (!dirty) return
  dirty = false
  const value = snapshot()
  if (!value) return
  if (sender) {
    try {
      sender(value)
    } catch {
      // Progress is advisory; it must never interrupt the local run.
    }
  }
  if (publisher) {
    try {
      publisher(value)
    } catch {
      // Same rule for the control plane: a failed report is not a failed task.
    }
  }
}

function schedule(): void {
  if (pushTimer !== null) return
  pushTimer = globalThis.setTimeout(push, PUSH_INTERVAL_MS)
}

function flush(): void {
  if (pushTimer !== null) {
    globalThis.clearTimeout(pushTimer)
    pushTimer = null
  }
  dirty = true
  push()
}

/**
 * Starts tracking a run.
 *
 * One user request can be executed as several runs: the agent loop submits a
 * new run per turn, carrying the same prompt forward. Those turns are one task
 * from the operator's point of view, so a matching prompt in the same session
 * continues the projection instead of wiping the steps a controller is reading.
 * A different prompt, or a different session, starts fresh.
 */
export function beginRemoteTaskRun(
  runId: string,
  prompt: string,
  sessionId?: string | null,
  workingDirectory?: string | null
): void {
  if (current?.runId === runId) return
  const title = oneLine(prompt || 'Ola task', 120)
  const directory = typeof workingDirectory === 'string' ? workingDirectory.trim() : ''
  const now = Date.now()
  const continues =
    current !== null &&
    current.done &&
    current.finishedAt !== null &&
    now - current.finishedAt <= CONTINUATION_WINDOW_MS &&
    current.sessionId === (sessionId ?? null) &&
    (!prompt.trim() || current.title === title)
  if (continues && current) {
    current = {
      ...current,
      runId,
      ...(directory ? { workingDirectory: directory } : {}),
      status: 'running',
      done: false,
      finishedAt: null,
      seq: 0,
      updatedAt: now
    }
    dirty = true
    schedule()
    return
  }
  current = {
    runId,
    sessionId: sessionId ?? null,
    status: 'running',
    title,
    workingDirectory: directory,
    startedAt: now,
    text: '',
    steps: [],
    seq: 0,
    updatedAt: now,
    done: false,
    finishedAt: null
  }
  flush()
}

/**
 * Folds one committed run event into the projection. Unknown event types are
 * ignored so a runtime that grows new events cannot break remote progress.
 */
export function publishRemoteRunEvent(runId: string, event: RunEvent): void {
  if (!current || current.runId !== runId) return
  const data = record(event.data)
  let changed = false

  if (event.type === 'run.status' && typeof data?.status === 'string') {
    const terminal = terminalStatus(data.status)
    if (terminal) {
      current.status = terminal
      current.done = true
      current.finishedAt = current.finishedAt ?? Date.now()
      changed = true
    } else if (data.status === 'waiting_interaction') {
      current.status = 'waiting_interaction'
      changed = true
    } else if (!current.done) {
      current.status = 'running'
      changed = true
    }
  } else if (event.type === 'message.delta' && typeof data?.text === 'string') {
    current.text += data.text
    if (current.text.length > TEXT_LIMIT) current.text = current.text.slice(-TEXT_LIMIT)
    changed = true
  } else if (
    event.type === 'tool.generated' &&
    typeof data?.id === 'string' &&
    typeof data.name === 'string'
  ) {
    if (current.steps.length >= MAX_STEPS) current.steps.shift()
    if (!current.workingDirectory) {
      const directory = directoryFromInput(data.input)
      if (directory) current.workingDirectory = directory
    }
    current.steps.push({
      id: data.id,
      name: data.name,
      status: 'running',
      startedAt: event.timestamp,
      summary: summarizeInput(data.input) || undefined
    })
    changed = true
  } else if (event.type === 'tool.result' && typeof data?.id === 'string') {
    const step = current.steps.find((item) => item.id === data.id)
    if (step) {
      step.status = data.isError === true ? 'failed' : 'completed'
      step.finishedAt = event.timestamp
      const output = summarizeOutput(data.output)
      if (output) step.output = output
      changed = true
    } else if (typeof data.name === 'string') {
      // A result without its generation event (a controller that joined late, or
      // an event folded into a snapshot before the projection existed) still
      // tells the operator something ran. Record it as finished rather than
      // showing an empty step list next to a working run.
      if (current.steps.length >= MAX_STEPS) current.steps.shift()
      const output = summarizeOutput(data.output)
      current.steps.push({
        id: data.id,
        name: data.name,
        status: data.isError === true ? 'failed' : 'completed',
        startedAt: event.timestamp,
        finishedAt: event.timestamp,
        ...(output ? { output } : {})
      })
      changed = true
    }
  }

  if (!changed) return
  current.seq = event.seq
  current.updatedAt = Date.now()
  dirty = true
  // Terminal frames are what a controller waits for, so they skip the timer.
  if (current.done) flush()
  else schedule()
}

/** Called when the local run stream ends without a terminal status. */
export function endRemoteTaskRun(runId: string, status: RemoteTaskStatus): void {
  if (!current || current.runId !== runId) return
  // A terminal `run.status` already described the outcome; do not overwrite it
  // with the reason the stream happened to close.
  if (current.done) return
  current.status = status
  current.done = true
  current.finishedAt = Date.now()
  current.updatedAt = Date.now()
  flush()
}

/** Drops the projection, e.g. when the control session closes. */
export function resetRemoteTask(): void {
  current = null
  dirty = false
  if (pushTimer !== null) {
    globalThis.clearTimeout(pushTimer)
    pushTimer = null
  }
}

/**
 * Drops the projection only when no run is in flight.
 *
 * A control session can close while the machine is still executing a task. The
 * projection is the only record of that run, so clearing it would leave the next
 * controller with an empty panel for the rest of the task — the events that
 * follow have no projection to fold into. A finished task is dropped normally:
 * the session that watched it is gone, and the next controller starts clean.
 */
export function resetRemoteTaskIfIdle(): void {
  if (current && !current.done) return
  resetRemoteTask()
}

/**
 * Re-publishes the current projection so a controller that just connected sees
 * a run that started before it. Returns false when nothing is tracked.
 */
export function replayRemoteTask(): boolean {
  if (!current) return false
  flush()
  return true
}

/** Test seam: read the projection without going through the peer channel. */
export function currentRemoteTaskSnapshot(): RemoteTaskSnapshot | null {
  return snapshot()
}
