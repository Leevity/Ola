import {
  TERMINAL_STATUSES,
  type PendingRuntimeInteraction,
  type RunEvent,
  type RunStatus,
  type RunSummary
} from './runtime/contracts'

export type ExecutionRecordSource = 'chat' | 'channel' | 'team' | 'cron'
export type ExecutionApprovalStatus = 'not_required' | 'approved' | 'rejected' | 'pending'

export interface ExecutionPageKey {
  at: number
  id: string
}

export interface ExecutionSourceCursor {
  anchor: ExecutionPageKey | null
  after: ExecutionPageKey | null
}

export interface ExecutionRecordCursor {
  ts: ExecutionSourceCursor
  cron: ExecutionSourceCursor
}

export interface ExecutionRecordFileChange {
  path: string
  operation: 'create' | 'modify'
  transport: 'local' | 'ssh'
}

export interface ExecutionRecord {
  id: string
  source: ExecutionRecordSource
  workspaceId: string
  status: RunStatus | 'pending' | 'skipped'
  startedAt: number
  finishedAt: number | null
  title: string
  /** Scheduler identity for Cron; distinct from this attempt's run ID. */
  jobId: string | null
  /** Runtime submission identity; not a business TaskItem ID. */
  runtimeTaskId: string | null
  businessTaskId: string | null
  sessionId: string | null
  projectId: string | null
  sshConnectionId: string | null
  approvalStatus: ExecutionApprovalStatus
  toolCallCount: number
  failedToolCallCount: number
  commandSummary: string | null
  fileChanges: ExecutionRecordFileChange[]
  artifacts: string[]
  failureReason: string | null
  deliveryStatus?: 'pending' | 'sent' | 'failed' | 'unknown' | null
}

export interface CronExecutionRecordInput {
  id: string
  jobId?: string | null
  workspaceId: string
  startedAt: number
  finishedAt?: number | null
  status: string
  jobName?: string | null
  sessionId?: string | null
  projectId?: string | null
  sshConnectionId?: string | null
  toolCallCount?: number | null
  error?: string | null
  deliveryMode?: string | null
  deliveryTarget?: string | null
  deliveryStatus?: 'pending' | 'sent' | 'failed' | 'unknown' | null
}

export function needsExecutionAttention(record: ExecutionRecord): boolean {
  return (
    record.approvalStatus === 'pending' ||
    record.status === 'waiting_interaction' ||
    record.status === 'waiting_capability' ||
    record.status === 'interrupted' ||
    record.status === 'failed' ||
    record.deliveryStatus === 'failed' ||
    record.deliveryStatus === 'unknown' ||
    record.deliveryStatus === 'pending'
  )
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 0x20 || code === 0x7f ? ' ' : character
    })
    .join('')
    .trim()
  return normalized ? normalized.slice(0, 4096) : null
}

function eventObject(event: RunEvent): Record<string, unknown> | null {
  return event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : null
}

function terminalEvent(events: readonly RunEvent[]): RunEvent | undefined {
  return [...events].reverse().find((event) => event.type === 'run.status')
}

function fileChanges(events: readonly RunEvent[]): ExecutionRecordFileChange[] {
  const seen = new Set<string>()
  const result: ExecutionRecordFileChange[] = []
  for (const event of events) {
    if (event.type !== 'file.change' && event.type !== 'file.changed') continue
    const data = eventObject(event)
    const path = text(data?.path ?? data?.filePath)
    if (!path || seen.has(path)) continue
    const operation = data?.operation === 'create' ? 'create' : 'modify'
    const transport = data?.transport === 'ssh' ? 'ssh' : 'local'
    seen.add(path)
    result.push({ path, operation, transport })
  }
  return result.slice(0, 256)
}

function artifacts(events: readonly RunEvent[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (!event.type.includes('artifact')) continue
    const data = eventObject(event)
    const value = text(data?.path ?? data?.name ?? data?.artifact)
    if (value && !seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  return result.slice(0, 256)
}

export function executionRecordFromTsRun(
  summary: RunSummary,
  events: readonly RunEvent[] = [],
  pendingInteractions: readonly PendingRuntimeInteraction[] = []
): ExecutionRecord {
  const terminal = terminalEvent(events)
  const terminalData = terminal ? eventObject(terminal) : null
  const terminalTimestamp =
    terminal && terminalData?.status === summary.status ? terminal.timestamp : null
  const failedToolCallCount = events.filter(
    (event) =>
      event.type === 'tool.failed' ||
      event.type === 'tool.error' ||
      (event.type === 'tool.result' && eventObject(event)?.isError === true)
  ).length
  const commands = events
    .filter((event) => event.type === 'command.started' || event.type === 'shell.started')
    .map((event) => text(eventObject(event)?.command ?? eventObject(event)?.cmd))
    .filter((value): value is string => Boolean(value))
  return {
    id: summary.runId,
    source: summary.teamContext ? 'team' : summary.channelContext ? 'channel' : 'chat',
    workspaceId: summary.workspaceId,
    status: summary.status,
    startedAt: summary.createdAt,
    finishedAt: TERMINAL_STATUSES.has(summary.status)
      ? (terminalTimestamp ?? summary.updatedAt)
      : null,
    title: summary.businessTaskTitle ?? summary.taskId,
    jobId: null,
    runtimeTaskId: summary.taskId,
    businessTaskId: summary.businessTaskId ?? null,
    sessionId: summary.sessionId,
    projectId: null,
    sshConnectionId: summary.sshConnectionId ?? null,
    approvalStatus:
      (!TERMINAL_STATUSES.has(summary.status) && pendingInteractions.length > 0) ||
      summary.status === 'waiting_interaction'
        ? 'pending'
        : events.some((event) => event.type === 'interaction.rejected')
          ? 'rejected'
          : events.some((event) => event.type === 'interaction.resolved')
            ? 'approved'
            : 'not_required',
    toolCallCount: events.filter((event) => event.type === 'tool.started').length,
    failedToolCallCount,
    commandSummary: commands[0] ?? null,
    fileChanges: fileChanges(events),
    artifacts: artifacts(events),
    failureReason: text(terminalData?.error ?? terminalData?.reason)
  }
}

export function executionRecordFromCronRun(input: CronExecutionRecordInput): ExecutionRecord {
  const status: ExecutionRecord['status'] =
    input.status === 'success' || input.status === 'completed'
      ? 'completed'
      : input.status === 'error' || input.status === 'failed'
        ? 'failed'
        : input.status === 'aborted' || input.status === 'cancelled'
          ? 'cancelled'
          : input.status === 'skipped'
            ? 'skipped'
            : input.status === 'running'
              ? 'running'
              : 'pending'
  const delivery = [text(input.deliveryMode), text(input.deliveryTarget)]
    .filter((value): value is string => Boolean(value))
    .join(' → ')
  return {
    id: input.id,
    source: 'cron',
    workspaceId: input.workspaceId,
    status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? null,
    title: text(input.jobName) ?? 'Cron execution',
    jobId: text(input.jobId),
    runtimeTaskId: null,
    businessTaskId: null,
    sessionId: text(input.sessionId),
    projectId: text(input.projectId),
    sshConnectionId: text(input.sshConnectionId),
    approvalStatus: 'not_required',
    toolCallCount: Math.max(0, Math.trunc(input.toolCallCount ?? 0)),
    failedToolCallCount: status === 'failed' ? 1 : 0,
    commandSummary: delivery || null,
    fileChanges: [],
    artifacts: [],
    failureReason: text(input.error),
    deliveryStatus: input.deliveryStatus ?? null
  }
}
