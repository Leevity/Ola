import type { RunEvent, RunStatus, RunSummary } from './runtime/contracts'

export type ExecutionRecordSource = 'chat' | 'cron'
export type ExecutionApprovalStatus = 'not_required' | 'approved' | 'rejected' | 'pending'

export interface ExecutionRecordFileChange {
  path: string
  operation: 'create' | 'modify'
  transport: 'local' | 'ssh'
}

export interface ExecutionRecord {
  id: string
  source: ExecutionRecordSource
  workspaceId: string
  status: RunStatus | 'pending'
  startedAt: number
  finishedAt: number | null
  title: string
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
}

export interface CronExecutionRecordInput {
  id: string
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

function statusFromRun(summary: RunSummary, events: readonly RunEvent[]): RunStatus {
  const terminal = terminalEvent(events)
  const value = terminal && eventObject(terminal)?.status
  return typeof value === 'string' ? (value as RunStatus) : summary.status
}

export function executionRecordFromTsRun(
  summary: RunSummary,
  events: readonly RunEvent[] = []
): ExecutionRecord {
  const terminal = terminalEvent(events)
  const terminalData = terminal ? eventObject(terminal) : null
  const failedToolCallCount = events.filter(
    (event) => event.type === 'tool.failed' || event.type === 'tool.error'
  ).length
  const commands = events
    .filter((event) => event.type === 'command.started' || event.type === 'shell.started')
    .map((event) => text(eventObject(event)?.command ?? eventObject(event)?.cmd))
    .filter((value): value is string => Boolean(value))
  return {
    id: summary.runId,
    source: 'chat',
    workspaceId: summary.workspaceId,
    status: statusFromRun(summary, events),
    startedAt: summary.createdAt,
    finishedAt: terminal ? terminal.timestamp : null,
    title: summary.taskId,
    sessionId: summary.sessionId,
    projectId: null,
    sshConnectionId: summary.sshConnectionId ?? null,
    approvalStatus: events.some((event) => event.type === 'interaction.rejected')
      ? 'rejected'
      : events.some((event) => event.type === 'interaction.resolved')
        ? 'approved'
        : events.some((event) => event.type === 'interaction.requested')
          ? 'pending'
          : 'not_required',
    toolCallCount: events.filter((event) => event.type.startsWith('tool.')).length,
    failedToolCallCount,
    commandSummary: commands[0] ?? null,
    fileChanges: fileChanges(events),
    artifacts: artifacts(events),
    failureReason: text(terminalData?.error ?? terminalData?.reason)
  }
}

export function executionRecordFromCronRun(input: CronExecutionRecordInput): ExecutionRecord {
  const status = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(
    input.status
  )
    ? (input.status as RunStatus)
    : 'failed'
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
    sessionId: text(input.sessionId),
    projectId: text(input.projectId),
    sshConnectionId: text(input.sshConnectionId),
    approvalStatus: 'not_required',
    toolCallCount: Math.max(0, Math.trunc(input.toolCallCount ?? 0)),
    failedToolCallCount: status === 'failed' ? 1 : 0,
    commandSummary: delivery || null,
    fileChanges: [],
    artifacts: [],
    failureReason: text(input.error)
  }
}
