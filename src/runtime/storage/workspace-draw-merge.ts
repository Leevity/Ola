import { createHash } from 'node:crypto'
import type {
  SyncConflict,
  SyncConflictResolution,
  SyncRecord,
  WorkspaceSyncBundle,
  WorkspaceSyncScope
} from '../../shared/sync-types'
import {
  hashSyncBundleContent,
  verifyWorkspaceSyncBundle,
  workspaceSyncScopeHash
} from '../../shared/sync-bundle-contract'
import type {
  BusinessWorkspaceSyncBaseline,
  BusinessWorkspaceSyncTombstone
} from './business-repository'
import { drawRecordInput } from './workspace-draw-record'

const DOMAIN = 'db:draw_runs'
type Tombstone = WorkspaceSyncBundle['tombstones'][number]
type State = { record?: SyncRecord; tombstone?: Tombstone }

export type WorkspaceDrawMergeResult =
  | { status: 'conflict'; conflicts: SyncConflict[] }
  | {
      status: 'ready'
      localContentHash: string
      bundle: WorkspaceSyncBundle
      recordsToApply: SyncRecord[]
      deletedIds: string[]
    }

function drawStates(bundle: WorkspaceSyncBundle | null, workspaceId: string): Map<string, State> {
  const states = new Map<string, State>()
  for (const record of bundle?.records ?? []) {
    if (record.domain !== DOMAIN) throw new Error('SYNC_DRAW_DOMAIN_UNSUPPORTED')
    drawRecordInput(record, workspaceId)
    states.set(record.recordId, { record })
  }
  for (const tombstone of bundle?.tombstones ?? []) {
    if (tombstone.domain !== DOMAIN) throw new Error('SYNC_DRAW_DOMAIN_UNSUPPORTED')
    if (states.get(tombstone.recordId)?.record) throw new Error('SYNC_DRAW_CONFLICTING_MUTATIONS')
    states.set(tombstone.recordId, { tombstone })
  }
  return states
}

function tombstoneWinner(local?: Tombstone, remote?: Tombstone): Tombstone | undefined {
  if (!local) return remote
  if (!remote) return local
  return remote.deletedAt > local.deletedAt ? remote : local
}

function conflict(
  scopeHash: string,
  kind: SyncConflict['kind'],
  recordId: string,
  baselineHash: string | undefined,
  local: State,
  remote: State
): SyncConflict {
  return {
    id: createHash('sha256')
      .update(
        JSON.stringify([
          scopeHash,
          DOMAIN,
          recordId,
          kind,
          baselineHash ?? null,
          local.record?.hash ?? null,
          local.tombstone ?? null,
          remote.record?.hash ?? null,
          remote.tombstone ?? null
        ])
      )
      .digest('hex'),
    kind,
    domain: DOMAIN,
    recordId,
    baselineHash: baselineHash ?? null,
    localHash: local.record?.hash ?? null,
    remoteHash: remote.record?.hash ?? null,
    localValue: local.record?.value,
    remoteValue: remote.record?.value,
    localDeleted: Boolean(local.tombstone),
    remoteDeleted: Boolean(remote.tombstone)
  }
}

/** Plan only: no local writes or remote upload until all conflicts are resolved. */
export function mergeWorkspaceDrawBundles(input: {
  scope: WorkspaceSyncScope
  local: WorkspaceSyncBundle
  remote: WorkspaceSyncBundle | null
  baseline: BusinessWorkspaceSyncBaseline[]
  resolutions?: SyncConflictResolution[]
  createdAt: number
}): WorkspaceDrawMergeResult {
  const local = verifyWorkspaceSyncBundle(input.local, input.scope)
  const remote = input.remote ? verifyWorkspaceSyncBundle(input.remote, input.scope) : null
  if (!Number.isSafeInteger(input.createdAt)) throw new Error('SYNC_DRAW_CREATED_AT_INVALID')
  const scopeHash = workspaceSyncScopeHash(input.scope)
  const localStates = drawStates(local, input.scope.workspaceId)
  const remoteStates = drawStates(remote, input.scope.workspaceId)
  const baseline = new Map<string, string>()
  for (const row of input.baseline) {
    if (row.domain !== DOMAIN) throw new Error('SYNC_DRAW_DOMAIN_UNSUPPORTED')
    if (!row.recordId || !/^[a-f0-9]{64}$/.test(row.contentHash) || baseline.has(row.recordId))
      throw new Error('SYNC_DRAW_BASELINE_INVALID')
    baseline.set(row.recordId, row.contentHash)
  }
  if (!remote && baseline.size > 0) throw new Error('SYNC_REMOTE_BASELINE_MISSING')
  const resolutions = new Map<string, 'local' | 'remote'>()
  for (const row of input.resolutions ?? []) {
    if (resolutions.has(row.conflictId) || !['local', 'remote'].includes(row.choice))
      throw new Error('SYNC_DRAW_RESOLUTION_INVALID')
    resolutions.set(row.conflictId, row.choice)
  }
  const conflicts: SyncConflict[] = []
  const selected = new Map<string, State>()
  const keys = new Set([...baseline.keys(), ...localStates.keys(), ...remoteStates.keys()])
  for (const id of [...keys].sort()) {
    const left = localStates.get(id) ?? {}
    const right = remoteStates.get(id) ?? {}
    const base = baseline.get(id)
    if (base && !left.record && !left.tombstone) throw new Error('SYNC_LOCAL_BASELINE_MISSING')
    if (base && remote && !right.record && !right.tombstone)
      throw new Error('SYNC_REMOTE_BASELINE_MISSING')
    let chosen: State | undefined
    let issue: SyncConflict | undefined
    if (left.record && right.record) {
      if (left.record.hash === right.record.hash || right.record.hash === base) chosen = left
      else if (left.record.hash === base) chosen = right
      else
        issue = conflict(scopeHash, base ? 'modify-modify' : 'create-create', id, base, left, right)
    } else if (left.record && right.tombstone) {
      if (left.record.hash === base) chosen = right
      else issue = conflict(scopeHash, 'delete-modify', id, base, left, right)
    } else if (left.tombstone && right.record) {
      if (right.record.hash === base) chosen = left
      else issue = conflict(scopeHash, 'delete-modify', id, base, left, right)
    } else if (left.tombstone || right.tombstone) {
      chosen = { tombstone: tombstoneWinner(left.tombstone, right.tombstone) }
    } else {
      chosen = left.record ? left : right
    }
    if (issue) {
      const choice = resolutions.get(issue.id)
      if (!choice) conflicts.push(issue)
      else {
        chosen = choice === 'local' ? left : right
        resolutions.delete(issue.id)
      }
    }
    if (chosen?.record || chosen?.tombstone) selected.set(id, chosen)
  }
  if (resolutions.size > 0) throw new Error('SYNC_DRAW_RESOLUTION_INVALID')
  if (conflicts.length > 0) return { status: 'conflict', conflicts }
  const records: SyncRecord[] = []
  const tombstones: BusinessWorkspaceSyncTombstone[] = []
  const recordsToApply: SyncRecord[] = []
  const deletedIds: string[] = []
  for (const [id, state] of selected) {
    if (state.record) {
      records.push(state.record)
      if (localStates.get(id)?.record?.hash !== state.record.hash) recordsToApply.push(state.record)
    } else if (state.tombstone) {
      tombstones.push(state.tombstone)
      if (localStates.get(id)?.record) deletedIds.push(id)
    }
  }
  const manifestBase: Omit<WorkspaceSyncBundle['manifest'], 'contentHash'> = {
    schemaVersion: 2,
    appVersion: local.manifest.appVersion,
    deviceId: local.manifest.deviceId,
    createdAt: input.createdAt,
    scopeHash,
    domains: records.length ? { [DOMAIN]: records.length } : {},
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
  return {
    status: 'ready',
    localContentHash: local.manifest.contentHash,
    bundle: verifyWorkspaceSyncBundle(bundle, input.scope),
    recordsToApply,
    deletedIds
  }
}
