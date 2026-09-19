import { getNativeWorker } from '../lib/native-worker'

import { loadOfflineWorkspaceIds } from '../remote/account-client'
import { getSession } from './sessions-dao'
import { canaryIndexSubAgentHistory, canaryListSubAgentHistory } from './legacy-read-canary'
import { businessWriteCanary } from './business-write-canary'

import type {
  SubAgentHistoryMigrationStatus,
  SubAgentHistoryMutation,
  SubAgentHistoryPage,
  SubAgentHistoryRow,
  SubAgentHistoryUpsertItem
} from '../../shared/sub-agent-history-types'

const DEFAULT_TIMEOUT_MS = 30_000
const REPLACE_TIMEOUT_MS = 60_000

async function requireSessionWorkspace(sessionId: string): Promise<string> {
  const session = await getSession(sessionId)
  if (!session) throw new Error('Sub-agent history session not found')
  const workspaceId = session.workspace_id
  if (workspaceId !== 'local-personal' && !(await loadOfflineWorkspaceIds()).has(workspaceId))
    throw new Error('Sub-agent history workspace is not available')
  return workspaceId
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  const candidate = Number.isFinite(value) ? Math.floor(value as number) : fallback
  if (candidate < 1) return fallback
  if (candidate > max) return max
  return candidate
}

function clampOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value as number))
}

function assertMutation(
  result: SubAgentHistoryMutation | undefined,
  op: string
): asserts result is SubAgentHistoryMutation {
  if (!result || !result.success) {
    throw new Error(result?.error || `Native sub-agent history ${op} failed`)
  }
}

export async function indexSubAgentHistory(
  sessionId: string,
  limit?: number
): Promise<SubAgentHistoryRow[]> {
  const workspaceId = await requireSessionWorkspace(sessionId)
  const scopedLimit = clampLimit(limit, 100, 500)
  const canary = await canaryIndexSubAgentHistory(sessionId, workspaceId, scopedLimit)
  if (canary !== undefined) return canary
  return getNativeWorker().request<SubAgentHistoryRow[]>(
    'db/sub-agent-history-index',
    { sessionId, workspaceId, limit: scopedLimit },
    DEFAULT_TIMEOUT_MS
  )
}

export async function listSubAgentHistory(args: {
  sessionId: string
  limit?: number
  offset?: number
}): Promise<SubAgentHistoryPage> {
  const workspaceId = await requireSessionWorkspace(args.sessionId)
  const scopedArgs = {
    sessionId: args.sessionId,
    workspaceId,
    limit: clampLimit(args.limit, 50, 200),
    offset: clampOffset(args.offset)
  }
  const canary = await canaryListSubAgentHistory(scopedArgs)
  if (canary !== undefined) return canary
  return getNativeWorker().request<SubAgentHistoryPage>(
    'db/sub-agent-history-list',
    scopedArgs,
    DEFAULT_TIMEOUT_MS
  )
}

export async function applySubAgentHistory(
  item: SubAgentHistoryUpsertItem,
  workspaceIdOverride?: string
): Promise<void> {
  const workspaceId = workspaceIdOverride ?? (await requireSessionWorkspace(item.sessionId))
  const writer = businessWriteCanary()
  if (writer) {
    await writer.applySubAgentHistory(item, workspaceId)
    return
  }
  const result = await getNativeWorker().request<SubAgentHistoryMutation>(
    'db/sub-agent-history-apply',
    { ...item, workspaceId },
    DEFAULT_TIMEOUT_MS
  )
  assertMutation(result, 'apply')
}

export async function replaceSubAgentHistory(args: {
  sessionId: string
  items: SubAgentHistoryUpsertItem[]
  workspaceId?: string
}): Promise<void> {
  const workspaceId = args.workspaceId ?? (await requireSessionWorkspace(args.sessionId))
  const writer = businessWriteCanary()
  if (writer) {
    await writer.replaceSubAgentHistory({ ...args, workspaceId })
    return
  }
  const result = await getNativeWorker().request<SubAgentHistoryMutation>(
    'db/sub-agent-history-replace',
    { ...args, workspaceId },
    REPLACE_TIMEOUT_MS
  )
  assertMutation(result, 'replace')
}

export function getSubAgentHistoryMigrationStatus(
  key: string
): Promise<SubAgentHistoryMigrationStatus> {
  return getNativeWorker().request<SubAgentHistoryMigrationStatus>(
    'db/sub-agent-history-migration-status',
    { key },
    DEFAULT_TIMEOUT_MS
  )
}

export async function markSubAgentHistoryMigration(args: {
  key: string
  appliedAt?: number
}): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.markSubAgentHistoryMigration(args.key, args.appliedAt ?? Date.now())
    return
  }
  const result = await getNativeWorker().request<SubAgentHistoryMutation>(
    'db/sub-agent-history-migration-mark',
    { ...args, appliedAt: args.appliedAt ?? Date.now() },
    DEFAULT_TIMEOUT_MS
  )
  assertMutation(result, 'migration-mark')
}
