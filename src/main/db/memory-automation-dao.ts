import { getTsDatabaseRouteGuard } from './business-write-canary'
import { businessWriteCanary } from './business-write-canary'
import {
  canaryGetMemoryAutomationEntry,
  canaryListMemoryAutomationEntries
} from './legacy-read-canary'
import type {
  MemoryAutomationEntry,
  MemoryAutomationListQuery,
  MemoryAutomationRecordInput,
  MemoryAutomationTarget
} from '../../shared/memory-automation-types'

interface MemoryAutomationEntryResult {
  success: boolean
  entry?: MemoryAutomationEntry | null
  error?: string | null
}

interface MemoryAutomationRollupResult {
  success: boolean
  alreadyProcessed: boolean
  error?: string | null
}

function unwrapEntryResult(
  result: MemoryAutomationEntryResult,
  operation: string
): MemoryAutomationEntry | null {
  if (!result.success) {
    throw new Error(result.error || `Native memory automation ${operation} failed`)
  }
  return result.entry ?? null
}

export async function addMemoryAutomationEntry(
  input: MemoryAutomationRecordInput
): Promise<MemoryAutomationEntry> {
  const writer = businessWriteCanary()
  if (writer) {
    const workspaceId = input.workspaceId ?? 'local-personal'
    return writer.recordMemoryAutomationEntry<MemoryAutomationEntry>({
      workspaceId,
      scope: input.scope,
      rootScope: input.rootScope ?? null,
      memoryRootId: input.memoryRootId ?? null,
      jobId: input.jobId ?? null,
      projectId: input.projectId ?? null,
      target: input.target,
      kind: input.kind,
      content: input.content,
      confidence: input.confidence ?? 0,
      sourceSessionId: input.sourceSessionId ?? null,
      targetPath: input.targetPath ?? null,
      status: input.status,
      filterReason: input.filterReason ?? null,
      fingerprint: input.fingerprint,
      evidenceJson:
        input.evidenceJson ??
        (input.evidence === undefined ? null : JSON.stringify(input.evidence)),
      writtenAt: input.writtenAt ?? null,
      error: input.error ?? null,
      beforeContent: input.beforeContent ?? null,
      afterContent: input.afterContent ?? null,
      appendedText: input.appendedText ?? null,
      sshConnectionId: input.sshConnectionId ?? null
    })
  }
  const result = await getTsDatabaseRouteGuard().request<MemoryAutomationEntryResult>(
    'db/memory-automation-add',
    input,
    120_000
  )
  const entry = unwrapEntryResult(result, 'add')
  if (!entry) {
    throw new Error('Native memory automation add returned no entry')
  }
  return entry
}

export async function getMemoryAutomationEntry(
  id: string,
  workspaceId = 'local-personal'
): Promise<MemoryAutomationEntry | null> {
  const canary = await canaryGetMemoryAutomationEntry(id, workspaceId)
  if (canary !== undefined) return canary
  const writer = businessWriteCanary()
  if (writer) return writer.memoryAutomationEntry<MemoryAutomationEntry>(id, workspaceId)
  const result = await getTsDatabaseRouteGuard().request<MemoryAutomationEntryResult>(
    'db/memory-automation-get',
    { id, workspaceId },
    120_000
  )
  return unwrapEntryResult(result, 'get')
}

export async function listMemoryAutomationEntries(
  query: MemoryAutomationListQuery = {}
): Promise<MemoryAutomationEntry[]> {
  if (query.workspaceId?.trim()) {
    const canary = await canaryListMemoryAutomationEntries({
      ...query,
      workspaceId: query.workspaceId
    })
    if (canary !== undefined) return canary
  }
  const writer = businessWriteCanary()
  if (writer) {
    return writer.memoryAutomationEntries<MemoryAutomationEntry>(
      query.workspaceId ?? 'local-personal',
      query.limit,
      query.offset,
      query.includeContentSnapshots
    )
  }
  return getTsDatabaseRouteGuard().request<MemoryAutomationEntry[]>(
    'db/memory-automation-list',
    query,
    120_000
  )
}

export async function markMemoryAutomationUndo(
  id: string,
  status: 'undone' | 'error' = 'undone',
  error?: string | null,
  workspaceId = 'local-personal'
): Promise<MemoryAutomationEntry | null> {
  const writer = businessWriteCanary()
  if (writer) {
    return writer.markMemoryAutomationUndo<MemoryAutomationEntry>({
      id,
      status,
      error: error ?? null,
      workspaceId
    })
  }
  const result = await getTsDatabaseRouteGuard().request<MemoryAutomationEntryResult>(
    'db/memory-automation-mark-undo',
    { id, status, error, workspaceId },
    120_000
  )
  return unwrapEntryResult(result, 'mark-undo')
}

export async function hasProcessedRollup(args: {
  workspaceId?: string
  scope: string
  targetPath: string
  sourceDate: string
  contentHash: string
}): Promise<boolean> {
  const writer = businessWriteCanary()
  if (writer) {
    const rows = await writer.memoryRollups<Record<string, unknown>>(
      args.workspaceId ?? 'local-personal'
    )
    return rows.some(
      (row) =>
        row.scope === args.scope &&
        row.target_path === args.targetPath &&
        row.source_date === args.sourceDate &&
        row.content_hash === args.contentHash
    )
  }
  const result = await getTsDatabaseRouteGuard().request<MemoryAutomationRollupResult>(
    'db/memory-automation-rollup-has',
    args,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native memory automation rollup lookup failed')
  }
  return result.alreadyProcessed
}

export async function markProcessedRollup(args: {
  workspaceId?: string
  scope: string
  target: MemoryAutomationTarget
  targetPath: string
  sourceDate: string
  contentHash: string
}): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.markMemoryRollup({
      workspaceId: args.workspaceId ?? 'local-personal',
      scope: args.scope,
      target: args.target,
      targetPath: args.targetPath,
      sourceDate: args.sourceDate,
      contentHash: args.contentHash
    })
    return
  }
  const result = await getTsDatabaseRouteGuard().request<MemoryAutomationRollupResult>(
    'db/memory-automation-rollup-mark',
    args,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native memory automation rollup mark failed')
  }
}
