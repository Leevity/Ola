import { invokeMessagePackBinary } from '../lib/ipc/messagepack-ipc-client'
import { IPC } from '../lib/ipc/channels'
import { toMessagePackChannel } from '../../../shared/messagepack/binary-ipc'
import type {
  SubAgentHistoryMigrationStatus,
  SubAgentHistoryPage,
  SubAgentHistoryRow,
  SubAgentHistoryStoredStatus,
  SubAgentHistoryUpsertItem
} from '../../../shared/sub-agent-history-types'

export const SUB_AGENT_HISTORY_MIGRATION_KEY = 'sub_agent_history.bootstrap.v1'
const APPLY_DEBOUNCE_MS = 750
const MAX_INDEX_LIMIT = 500
const MAX_FETCHED_ROWS = 50

function normalizeStatus(sa: {
  isRunning?: boolean
  success?: boolean | null
  errorMessage?: string | null
  cancelled?: boolean
}): SubAgentHistoryStoredStatus {
  if (sa.isRunning) return 'running'
  if (sa.cancelled) return 'cancelled'
  if (sa.errorMessage && sa.errorMessage.trim().length > 0) return 'failed'
  if (sa.success === false) return 'failed'
  return 'completed'
}

function clampCompletedAt(sa: {
  isRunning: boolean
  completedAt?: number | null
  startedAt: number
}): number | null {
  if (sa.isRunning) return null
  if (sa.completedAt && Number.isFinite(sa.completedAt)) return sa.completedAt
  return sa.startedAt
}

export function buildSubAgentHistoryUpsert(
  snapshot: Record<string, unknown>,
  sessionId: string,
  sortOrder: number,
  now: number = Date.now()
): SubAgentHistoryUpsertItem {
  const startedAtRaw = snapshot.startedAt
  const startedAt =
    typeof startedAtRaw === 'number' && Number.isFinite(startedAtRaw) ? startedAtRaw : now
  const status = normalizeStatus({
    isRunning: Boolean(snapshot.isRunning),
    success: (snapshot.success as boolean | null | undefined) ?? null,
    errorMessage: (snapshot.errorMessage as string | null | undefined) ?? null,
    cancelled: Boolean(snapshot.cancelled)
  })
  const normalizedForSnapshot = {
    ...snapshot,
    isRunning: status === 'running'
  }
  const completedAt = clampCompletedAt({
    isRunning: status === 'running',
    completedAt: (snapshot.completedAt as number | null | undefined) ?? null,
    startedAt
  })
  return {
    id: `ola_subagent_${String(snapshot.toolUseId)}`,
    sessionId,
    subAgentId: String(snapshot.toolUseId),
    toolUseId: String(snapshot.toolUseId),
    name: String(snapshot.displayName ?? snapshot.name ?? ''),
    status,
    startedAt,
    completedAt,
    updatedAt: now,
    sortOrder,
    snapshotJson: JSON.stringify({ ...normalizedForSnapshot, completedAt })
  }
}

const applyQueue = new Map<string, SubAgentHistoryUpsertItem>()
let applyTimer: ReturnType<typeof setTimeout> | null = null
let migrationInFlight = false

async function flushApplyQueue(): Promise<void> {
  applyTimer = null
  const items = Array.from(applyQueue.values())
  if (items.length === 0) return
  applyQueue.clear()
  for (const item of items) {
    try {
      await invokeMessagePackBinary(toMessagePackChannel(IPC.SUB_AGENT_HISTORY_APPLY), item)
    } catch (err) {
      console.warn('[SubAgentHistory] apply failed:', err)
    }
  }
}

export function scheduleSubAgentHistoryApply(item: SubAgentHistoryUpsertItem): void {
  applyQueue.set(`${item.sessionId}:${item.toolUseId}`, item)
  if (applyTimer) return
  applyTimer = setTimeout(() => {
    void flushApplyQueue()
  }, APPLY_DEBOUNCE_MS)
}

export async function flushSubAgentHistoryApplyNow(): Promise<void> {
  if (applyTimer) {
    clearTimeout(applyTimer)
    applyTimer = null
  }
  await flushApplyQueue()
}

export async function migrateLegacySubAgentHistory(
  readLegacy: () => Promise<Record<string, unknown[] | undefined>>
): Promise<{ applied: boolean; reason?: string }> {
  if (migrationInFlight) return { applied: true, reason: 'in-flight' }
  migrationInFlight = true
  try {
    const status = await invokeMessagePackBinary<SubAgentHistoryMigrationStatus>(
      toMessagePackChannel(IPC.SUB_AGENT_HISTORY_MIGRATION_STATUS),
      { key: SUB_AGENT_HISTORY_MIGRATION_KEY }
    )
    if (status.applied) {
      return { applied: true, reason: 'previously-applied' }
    }
    const legacy = await readLegacy()
    for (const [sessionId, items] of Object.entries(legacy)) {
      if (!sessionId || !Array.isArray(items) || items.length === 0) continue
      const upserts: SubAgentHistoryUpsertItem[] = []
      items.forEach((raw, idx) => {
        if (!raw || typeof raw !== 'object') return
        try {
          upserts.push(
            buildSubAgentHistoryUpsert(
              raw as Record<string, unknown>,
              sessionId,
              items.length - idx
            )
          )
        } catch (err) {
          console.warn(`[SubAgentHistory] dropped legacy entry (sessionId=${sessionId}):`, err)
        }
      })
      if (upserts.length === 0) continue
      await invokeMessagePackBinary(toMessagePackChannel(IPC.SUB_AGENT_HISTORY_REPLACE), {
        sessionId,
        items: upserts
      })
    }
    await invokeMessagePackBinary(toMessagePackChannel(IPC.SUB_AGENT_HISTORY_MIGRATION_MARK), {
      key: SUB_AGENT_HISTORY_MIGRATION_KEY
    })
    return { applied: true }
  } catch (err) {
    console.warn('[SubAgentHistory] migration failed:', err)
    return { applied: false, reason: String(err) }
  } finally {
    migrationInFlight = false
  }
}

export async function getSessionSubAgentHistoryRows(
  sessionId: string,
  limit: number = MAX_FETCHED_ROWS
): Promise<SubAgentHistoryRow[]> {
  if (!sessionId) return []
  try {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), MAX_INDEX_LIMIT)
    const page = await invokeMessagePackBinary<SubAgentHistoryPage>(
      toMessagePackChannel(IPC.SUB_AGENT_HISTORY_LIST),
      { sessionId, limit: safeLimit, offset: 0 }
    )
    return page.items
  } catch (err) {
    console.warn(`[SubAgentHistory] list fetch failed (sessionId=${sessionId}):`, err)
    return []
  }
}

export function parseSubAgentHistorySnapshot(
  row: SubAgentHistoryRow
): Record<string, unknown> | null {
  if (!row.snapshotJson) return null
  try {
    const snapshot = JSON.parse(row.snapshotJson)
    if (snapshot && typeof snapshot === 'object') {
      return snapshot as Record<string, unknown>
    }
    return null
  } catch (err) {
    console.warn('[SubAgentHistory] failed to parse snapshot row:', row.id, err)
    return null
  }
}
