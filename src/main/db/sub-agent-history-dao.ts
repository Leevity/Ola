import { getNativeWorker } from '../lib/native-worker'

import type {
  SubAgentHistoryMigrationStatus,
  SubAgentHistoryMutation,
  SubAgentHistoryPage,
  SubAgentHistoryRow,
  SubAgentHistoryUpsertItem
} from '../../shared/sub-agent-history-types'

const DEFAULT_TIMEOUT_MS = 30_000
const REPLACE_TIMEOUT_MS = 60_000

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

export function indexSubAgentHistory(
  sessionId: string,
  limit?: number
): Promise<SubAgentHistoryRow[]> {
  return getNativeWorker().request<SubAgentHistoryRow[]>(
    'db/sub-agent-history-index',
    { sessionId, limit: clampLimit(limit, 100, 500) },
    DEFAULT_TIMEOUT_MS
  )
}

export function listSubAgentHistory(args: {
  sessionId: string
  limit?: number
  offset?: number
}): Promise<SubAgentHistoryPage> {
  return getNativeWorker().request<SubAgentHistoryPage>(
    'db/sub-agent-history-list',
    {
      sessionId: args.sessionId,
      limit: clampLimit(args.limit, 50, 200),
      offset: clampOffset(args.offset)
    },
    DEFAULT_TIMEOUT_MS
  )
}

export async function applySubAgentHistory(item: SubAgentHistoryUpsertItem): Promise<void> {
  const result = await getNativeWorker().request<SubAgentHistoryMutation>(
    'db/sub-agent-history-apply',
    item,
    DEFAULT_TIMEOUT_MS
  )
  assertMutation(result, 'apply')
}

export async function replaceSubAgentHistory(args: {
  sessionId: string
  items: SubAgentHistoryUpsertItem[]
}): Promise<void> {
  const result = await getNativeWorker().request<SubAgentHistoryMutation>(
    'db/sub-agent-history-replace',
    args,
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
  const result = await getNativeWorker().request<SubAgentHistoryMutation>(
    'db/sub-agent-history-migration-mark',
    { ...args, appliedAt: args.appliedAt ?? Date.now() },
    DEFAULT_TIMEOUT_MS
  )
  assertMutation(result, 'migration-mark')
}
