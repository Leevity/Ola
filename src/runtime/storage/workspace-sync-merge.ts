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

type State = { record?: SyncRecord; tombstone?: WorkspaceSyncBundle['tombstones'][number] }

export type WorkspaceSyncMergeResult =
  | { status: 'conflict'; conflicts: SyncConflict[] }
  | {
      status: 'ready'
      localContentHash: string
      bundle: WorkspaceSyncBundle
      recordsToApply: SyncRecord[]
      deleted: Array<{ domain: string; recordId: string }>
    }

function key(domain: string, recordId: string): string {
  return `${domain}\u0000${recordId}`
}

function states(bundle: WorkspaceSyncBundle | null): Map<string, State> {
  const result = new Map<string, State>()
  for (const record of bundle?.records ?? [])
    result.set(key(record.domain, record.recordId), { record })
  for (const tombstone of bundle?.tombstones ?? []) {
    const itemKey = key(tombstone.domain, tombstone.recordId)
    if (result.get(itemKey)?.record) throw new Error('SYNC_CONFLICTING_MUTATIONS')
    result.set(itemKey, { tombstone })
  }
  return result
}

function tombstoneWinner(
  local: WorkspaceSyncBundle['tombstones'][number] | undefined,
  remote: WorkspaceSyncBundle['tombstones'][number] | undefined
): WorkspaceSyncBundle['tombstones'][number] | undefined {
  if (!local) return remote
  if (!remote) return local
  return remote.deletedAt > local.deletedAt ? remote : local
}

function conflict(
  scopeHash: string,
  domain: string,
  recordId: string,
  kind: SyncConflict['kind'],
  baselineHash: string | undefined,
  local: State,
  remote: State
): SyncConflict {
  return {
    id: createHash('sha256')
      .update(
        JSON.stringify([
          scopeHash,
          domain,
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
    domain,
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

function buildBundle(
  scope: WorkspaceSyncScope,
  source: WorkspaceSyncBundle,
  records: SyncRecord[],
  tombstones: WorkspaceSyncBundle['tombstones'],
  createdAt: number
): WorkspaceSyncBundle {
  const manifestBase: Omit<WorkspaceSyncBundle['manifest'], 'contentHash'> = {
    schemaVersion: 2,
    appVersion: source.manifest.appVersion,
    deviceId: source.manifest.deviceId,
    createdAt,
    scopeHash: workspaceSyncScopeHash(scope),
    domains: records.reduce<Record<string, number>>((counts, record) => {
      counts[record.domain] = (counts[record.domain] ?? 0) + 1
      return counts
    }, {}),
    tombstones: tombstones.length
  }
  return verifyWorkspaceSyncBundle(
    {
      manifest: {
        ...manifestBase,
        contentHash: hashSyncBundleContent(manifestBase, records, tombstones)
      },
      records,
      tombstones
    },
    scope
  )
}

/** Conflict planner for every workspace-owned DB domain, not only Draw. */
export function mergeWorkspaceBundles(input: {
  scope: WorkspaceSyncScope
  local: WorkspaceSyncBundle
  remote: WorkspaceSyncBundle | null
  baseline: BusinessWorkspaceSyncBaseline[]
  resolutions?: SyncConflictResolution[]
  createdAt: number
}): WorkspaceSyncMergeResult {
  const local = verifyWorkspaceSyncBundle(input.local, input.scope)
  const remote = input.remote ? verifyWorkspaceSyncBundle(input.remote, input.scope) : null
  if (!Number.isSafeInteger(input.createdAt)) throw new Error('SYNC_CREATED_AT_INVALID')
  const scopeHash = workspaceSyncScopeHash(input.scope)
  const localStates = states(local)
  const remoteStates = states(remote)
  const baseline = new Map<string, string>()
  for (const row of input.baseline) {
    if (!row.domain || !row.recordId || !/^[a-f0-9]{64}$/.test(row.contentHash))
      throw new Error('SYNC_BASELINE_INVALID')
    baseline.set(key(row.domain, row.recordId), row.contentHash)
  }
  if (!remote && baseline.size > 0) throw new Error('SYNC_REMOTE_BASELINE_MISSING')
  const resolutions = new Map<string, 'local' | 'remote'>()
  for (const resolution of input.resolutions ?? []) {
    if (resolutions.has(resolution.conflictId) || !['local', 'remote'].includes(resolution.choice))
      throw new Error('SYNC_RESOLUTION_INVALID')
    resolutions.set(resolution.conflictId, resolution.choice)
  }
  const selected = new Map<string, State>()
  const conflicts: SyncConflict[] = []
  const keys = new Set([...baseline.keys(), ...localStates.keys(), ...remoteStates.keys()])
  for (const itemKey of [...keys].sort()) {
    const separator = itemKey.indexOf('\u0000')
    const domain = itemKey.slice(0, separator)
    const recordId = itemKey.slice(separator + 1)
    const left = localStates.get(itemKey) ?? {}
    const right = remoteStates.get(itemKey) ?? {}
    const base = baseline.get(itemKey)
    if (base && !left.record && !left.tombstone) throw new Error('SYNC_LOCAL_BASELINE_MISSING')
    if (base && remote && !right.record && !right.tombstone)
      throw new Error('SYNC_REMOTE_BASELINE_MISSING')

    let chosen: State | undefined
    let issue: SyncConflict | undefined
    if (left.record && right.record) {
      if (left.record.hash === right.record.hash || right.record.hash === base) chosen = left
      else if (left.record.hash === base) chosen = right
      else
        issue = conflict(
          scopeHash,
          domain,
          recordId,
          base ? 'modify-modify' : 'create-create',
          base,
          left,
          right
        )
    } else if (left.record && right.tombstone) {
      if (left.record.hash === base) chosen = right
      else issue = conflict(scopeHash, domain, recordId, 'delete-modify', base, left, right)
    } else if (left.tombstone && right.record) {
      if (right.record.hash === base) chosen = left
      else issue = conflict(scopeHash, domain, recordId, 'delete-modify', base, left, right)
    } else if (left.tombstone || right.tombstone)
      chosen = { tombstone: tombstoneWinner(left.tombstone, right.tombstone) }
    else chosen = left.record ? left : right

    if (issue) {
      const choice = resolutions.get(issue.id)
      if (!choice) conflicts.push(issue)
      else {
        chosen = choice === 'local' ? left : right
        resolutions.delete(issue.id)
      }
    }
    if (chosen?.record || chosen?.tombstone) selected.set(itemKey, chosen)
  }
  if (resolutions.size > 0) throw new Error('SYNC_RESOLUTION_INVALID')
  if (conflicts.length > 0) return { status: 'conflict', conflicts }

  const records: SyncRecord[] = []
  const tombstones: BusinessWorkspaceSyncTombstone[] = []
  const recordsToApply: SyncRecord[] = []
  const deleted: Array<{ domain: string; recordId: string }> = []
  for (const [itemKey, state] of selected) {
    if (state.record) {
      records.push(state.record)
      if (localStates.get(itemKey)?.record?.hash !== state.record.hash)
        recordsToApply.push(state.record)
    } else if (state.tombstone) {
      tombstones.push(state.tombstone)
      if (localStates.get(itemKey)?.record)
        deleted.push({ domain: state.tombstone.domain, recordId: state.tombstone.recordId })
    }
  }
  return {
    status: 'ready',
    localContentHash: local.manifest.contentHash,
    bundle: buildBundle(input.scope, local, records, tombstones, input.createdAt),
    recordsToApply,
    deleted
  }
}
