import type { SyncRecord, SyncTombstone } from '../../shared/sync-types'
import { getNativeWorker } from '../lib/native-worker'
import { businessWriteCanary } from './business-write-canary'

export interface DbSyncRecordDraft {
  domain: string
  recordId: string
  value: unknown
  updatedAt?: number | null
}

export interface DbSyncBaselineRecordState {
  domain: string
  recordId: string
  contentHash: string
}

interface DbSyncSnapshotResult {
  success: boolean
  records: DbSyncRecordDraft[]
  baseline: DbSyncBaselineRecordState[]
  tombstones: SyncTombstone[]
  error?: string | null
}

interface DbSyncMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

export interface DbSyncSnapshot {
  records: DbSyncRecordDraft[]
  baseline: DbSyncBaselineRecordState[]
  tombstones: SyncTombstone[]
}

function assertMutation(result: DbSyncMutationResult, operation: string): DbSyncMutationResult {
  if (!result.success) {
    throw new Error(result.error || `Native sync DB ${operation} failed`)
  }
  return result
}

export async function captureSyncDbSnapshot(providerId: string): Promise<DbSyncSnapshot> {
  const writer = businessWriteCanary()
  if (writer) {
    const snapshot = await writer.syncCaptureLocal(providerId)
    return {
      records: snapshot.records,
      baseline: snapshot.baseline,
      tombstones: snapshot.tombstones
    }
  }
  console.log('[SyncDb][Native] capture snapshot start')
  const result = await getNativeWorker().request<DbSyncSnapshotResult>(
    'db/sync-capture-local',
    { providerId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native sync DB snapshot failed')
  }
  console.log('[SyncDb][Native] capture snapshot done', {
    records: result.records.length,
    baseline: result.baseline.length,
    tombstones: result.tombstones.length
  })
  return {
    records: result.records,
    baseline: result.baseline,
    tombstones: result.tombstones
  }
}

export async function applySyncDbMerge(args: {
  recordsToApply: SyncRecord[]
  recordsToDelete: Array<Pick<SyncTombstone, 'domain' | 'recordId'>>
}): Promise<void> {
  if (args.recordsToApply.length === 0 && args.recordsToDelete.length === 0) return
  const writer = businessWriteCanary()
  if (writer) {
    const result = await writer.syncApplyDbMerge(args)
    assertMutation(result, 'apply merge')
    return
  }
  console.log('[SyncDb][Native] apply DB merge start', {
    apply: args.recordsToApply.length,
    delete: args.recordsToDelete.length
  })
  const result = await getNativeWorker().request<DbSyncMutationResult>(
    'db/sync-apply-db-merge',
    args,
    120_000
  )
  assertMutation(result, 'apply merge')
  console.log('[SyncDb][Native] apply DB merge done', { changed: result.changed })
}

export async function saveSyncDbMetadata(
  providerId: string,
  records: Array<Pick<SyncRecord, 'domain' | 'recordId' | 'hash'>>,
  tombstones: SyncTombstone[]
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    const result = await writer.syncSaveMetadata({ providerId, records, tombstones })
    assertMutation(result, 'save metadata')
    return
  }
  console.log('[SyncDb][Native] save metadata start', {
    records: records.length,
    tombstones: tombstones.length
  })
  const result = await getNativeWorker().request<DbSyncMutationResult>(
    'db/sync-save-metadata',
    { providerId, records, tombstones },
    120_000
  )
  assertMutation(result, 'save metadata')
  console.log('[SyncDb][Native] save metadata done', { changed: result.changed })
}
