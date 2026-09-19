import type { WorkspaceSyncBundle, WorkspaceSyncScope } from '../../shared/sync-types'
import {
  hashSyncBundleContent,
  hashSyncRecordValue,
  verifyWorkspaceSyncBundle,
  workspaceSyncScopeHash
} from '../../shared/sync-bundle-contract'
import type { BusinessRepository, BusinessWorkspaceSyncBaseline } from './business-repository'
import type { WorkspaceDrawMergeResult } from './workspace-draw-merge'
import { drawRecordInput, type DrawSyncRow } from './workspace-draw-record'

const DRAW_DOMAIN = 'db:draw_runs'

interface CaptureWorkspaceDrawInput {
  repository: Pick<BusinessRepository, 'captureWorkspaceDrawSyncSnapshot'>
  scope: WorkspaceSyncScope
  providerId: string
  deviceId: string
  appVersion: string
  createdAt: number
  authorize: () => Promise<void>
}

/** TS-owned database slice used after the business-data handover, not on a live Native writer. */
export interface WorkspaceDrawCapturedState {
  bundle: WorkspaceSyncBundle
  baseline: BusinessWorkspaceSyncBaseline[]
  revisionToken: string
}

export async function captureWorkspaceDrawState(
  input: CaptureWorkspaceDrawInput
): Promise<WorkspaceDrawCapturedState> {
  await input.authorize()
  const scopeHash = workspaceSyncScopeHash(input.scope)
  const snapshot = await input.repository.captureWorkspaceDrawSyncSnapshot<DrawSyncRow>({
    scopeHash,
    workspaceId: input.scope.workspaceId,
    providerId: input.providerId,
    deviceId: input.deviceId,
    createdAt: input.createdAt
  })
  const records = snapshot.rows.map((row) => {
    const value = { table: 'draw_runs', row }
    const record = {
      domain: DRAW_DOMAIN,
      recordId: row.id,
      hash: hashSyncRecordValue(value),
      value,
      updatedAt: row.updated_at
    }
    drawRecordInput(record, input.scope.workspaceId)
    return record
  })
  const tombstones = snapshot.tombstones
  const manifestBase: Omit<WorkspaceSyncBundle['manifest'], 'contentHash'> = {
    schemaVersion: 2,
    appVersion: input.appVersion,
    deviceId: input.deviceId,
    createdAt: input.createdAt,
    scopeHash,
    domains: records.length ? { [DRAW_DOMAIN]: records.length } : {},
    tombstones: tombstones.length
  }
  const bundle: WorkspaceSyncBundle = {
    manifest: {
      ...manifestBase,
      contentHash: hashSyncBundleContent(manifestBase, records, tombstones)
    },
    records,
    tombstones
  }
  await input.authorize()
  return {
    bundle: verifyWorkspaceSyncBundle(bundle, input.scope),
    baseline: snapshot.baseline,
    revisionToken: snapshot.revisionToken
  }
}

export async function captureWorkspaceDrawBundle(
  input: CaptureWorkspaceDrawInput
): Promise<WorkspaceSyncBundle> {
  return (await captureWorkspaceDrawState(input)).bundle
}

/** Transactional application; callers must not advance a sync baseline on failure. */
export async function applyWorkspaceDrawBundle(input: {
  repository: Pick<BusinessRepository, 'applyDrawSyncBatch'>
  scope: WorkspaceSyncScope
  bundle: WorkspaceSyncBundle
  authorize: () => Promise<void>
}): Promise<{ saved: number; deleted: number }> {
  await input.authorize()
  const bundle = verifyWorkspaceSyncBundle(input.bundle, input.scope)
  const records = bundle.records.map((record) => drawRecordInput(record, input.scope.workspaceId))
  const deletedIds = bundle.tombstones.map((tombstone) => {
    if (tombstone.domain !== DRAW_DOMAIN) throw new Error('SYNC_DRAW_DOMAIN_UNSUPPORTED')
    if (records.some((record) => record.id === tombstone.recordId))
      throw new Error('SYNC_DRAW_CONFLICTING_MUTATIONS')
    return tombstone.recordId
  })
  await input.authorize()
  const result = await input.repository.applyDrawSyncBatch({
    workspaceId: input.scope.workspaceId,
    records,
    deletedIds
  })
  await input.authorize()
  return result
}

/** Call only after the merged bundle was uploaded with a remote conditional write. */
export async function commitWorkspaceDrawMerge(input: {
  repository: Pick<BusinessRepository, 'commitWorkspaceDrawSync'>
  scope: WorkspaceSyncScope
  providerId: string
  captured: WorkspaceDrawCapturedState
  merge: WorkspaceDrawMergeResult
  syncedAt: number
  authorize: () => Promise<void>
}): Promise<{ saved: number; deleted: number; revisionToken: string }> {
  if (input.merge.status !== 'ready') throw new Error('SYNC_DRAW_CONFLICT_UNRESOLVED')
  await input.authorize()
  const captured = verifyWorkspaceSyncBundle(input.captured.bundle, input.scope)
  const merged = verifyWorkspaceSyncBundle(input.merge.bundle, input.scope)
  if (captured.manifest.contentHash !== input.merge.localContentHash)
    throw new Error('SYNC_DRAW_CAPTURE_MISMATCH')
  const mergedRecordIds = new Set(merged.records.map((record) => record.recordId))
  const mergedTombstoneIds = new Set(merged.tombstones.map((row) => row.recordId))
  if (
    input.merge.recordsToApply.some((record) => !mergedRecordIds.has(record.recordId)) ||
    input.merge.deletedIds.some((id) => !mergedTombstoneIds.has(id))
  )
    throw new Error('SYNC_DRAW_MERGE_INVALID')
  const records = input.merge.recordsToApply.map((record) =>
    drawRecordInput(record, input.scope.workspaceId)
  )
  const expectedRows = merged.records.map((record) => {
    drawRecordInput(record, input.scope.workspaceId)
    return (record.value as { row: DrawSyncRow }).row
  })
  await input.authorize()
  const result = await input.repository.commitWorkspaceDrawSync({
    scopeHash: workspaceSyncScopeHash(input.scope),
    workspaceId: input.scope.workspaceId,
    providerId: input.providerId,
    expectedRevisionToken: input.captured.revisionToken,
    syncedAt: input.syncedAt,
    records,
    deletedIds: input.merge.deletedIds,
    expectedRows,
    baseline: merged.records.map((record) => ({
      domain: record.domain,
      recordId: record.recordId,
      contentHash: record.hash
    })),
    tombstones: merged.tombstones
  })
  await input.authorize()
  return result
}
