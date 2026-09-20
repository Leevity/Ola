import { createHash } from 'node:crypto'
import type {
  SyncBundle,
  SyncBundleManifest,
  WorkspaceSyncBundle,
  WorkspaceSyncScope
} from './sync-types'

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export function hashSyncRecordValue(value: unknown): string {
  return sha256(value)
}

export function hashSyncBundleContent(
  manifest: Omit<SyncBundleManifest, 'contentHash'>,
  records: SyncBundle['records'],
  tombstones: SyncBundle['tombstones']
): string {
  return sha256({ manifest, records, tombstones })
}

function recordKey(domain: string, id: string): string {
  return JSON.stringify([domain, id])
}

export function workspaceSyncScopeHash(scope: WorkspaceSyncScope): string {
  if (
    !scope.accountId ||
    !scope.apiBaseUrl ||
    !scope.workspaceId ||
    scope.accountId.length > 1024 ||
    scope.apiBaseUrl.length > 2048 ||
    scope.workspaceId.length > 1024
  )
    throw new Error('SYNC_WORKSPACE_SCOPE_INVALID')
  let apiBaseUrl: URL
  try {
    apiBaseUrl = new URL(scope.apiBaseUrl.trim())
  } catch {
    throw new Error('SYNC_WORKSPACE_SCOPE_INVALID')
  }
  if (
    !['https:', 'http:'].includes(apiBaseUrl.protocol) ||
    apiBaseUrl.username ||
    apiBaseUrl.password ||
    apiBaseUrl.search ||
    apiBaseUrl.hash
  )
    throw new Error('SYNC_WORKSPACE_SCOPE_INVALID')
  const authority = `${apiBaseUrl.origin}${apiBaseUrl.pathname.replace(/\/+$/, '')}`
  return sha256([authority, scope.accountId, scope.workspaceId])
}

function verifySyncBundle(value: unknown, scope?: WorkspaceSyncScope): SyncBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('SYNC_BUNDLE_INVALID')
  const bundle = value as Partial<SyncBundle>
  const manifest = bundle.manifest as WorkspaceSyncBundle['manifest'] | undefined
  if (
    !manifest ||
    manifest.schemaVersion !== (scope ? 2 : 1) ||
    (scope && manifest.scopeHash !== workspaceSyncScopeHash(scope)) ||
    typeof manifest.appVersion !== 'string' ||
    typeof manifest.deviceId !== 'string' ||
    !Number.isSafeInteger(manifest.createdAt) ||
    !manifest.domains ||
    typeof manifest.domains !== 'object' ||
    Array.isArray(manifest.domains) ||
    !Number.isSafeInteger(manifest.tombstones) ||
    !Array.isArray(bundle.records) ||
    !Array.isArray(bundle.tombstones) ||
    !/^[a-f0-9]{64}$/.test(manifest.contentHash)
  )
    throw new Error('SYNC_BUNDLE_INVALID')

  const domains: Record<string, number> = Object.create(null)
  const recordIds = new Set<string>()
  for (const record of bundle.records) {
    if (
      !record ||
      typeof record.domain !== 'string' ||
      !record.domain ||
      (record.domain !== 'file' && !/^db:[A-Za-z_][A-Za-z0-9_]*$/.test(record.domain)) ||
      typeof record.recordId !== 'string' ||
      !record.recordId ||
      record.value === undefined ||
      typeof record.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.hash) ||
      (record.updatedAt != null && !Number.isFinite(record.updatedAt))
    )
      throw new Error('SYNC_BUNDLE_INVALID')
    const key = recordKey(record.domain, record.recordId)
    if (recordIds.has(key) || hashSyncRecordValue(record.value) !== record.hash)
      throw new Error('SYNC_BUNDLE_INVALID')
    recordIds.add(key)
    domains[record.domain] = (domains[record.domain] ?? 0) + 1
    if (scope && record.domain === 'file') throw new Error('SYNC_BUNDLE_SCOPE_UNSUPPORTED')
    if (record.domain.startsWith('db:') && record.value && typeof record.value === 'object') {
      const row = (record.value as { row?: unknown }).row
      if (scope) {
        const rowWorkspaceId =
          row && typeof row === 'object'
            ? (row as { workspace_id?: unknown }).workspace_id
            : undefined
        if (record.workspaceId !== scope.workspaceId && rowWorkspaceId !== scope.workspaceId)
          throw new Error('SYNC_BUNDLE_WORKSPACE_MISMATCH')
      } else if (row && typeof row === 'object' && 'workspace_id' in row) {
        if ((row as { workspace_id: unknown }).workspace_id !== 'local-personal')
          throw new Error('LEGACY_SYNC_TEAM_WORKSPACE_UNSUPPORTED')
      }
    } else if (scope) {
      throw new Error('SYNC_BUNDLE_WORKSPACE_MISMATCH')
    }
  }

  const tombstoneIds = new Set<string>()
  for (const tombstone of bundle.tombstones) {
    if (
      !tombstone ||
      typeof tombstone.domain !== 'string' ||
      !tombstone.domain ||
      (tombstone.domain !== 'file' && !/^db:[A-Za-z_][A-Za-z0-9_]*$/.test(tombstone.domain)) ||
      typeof tombstone.recordId !== 'string' ||
      !tombstone.recordId ||
      typeof tombstone.originDeviceId !== 'string' ||
      !Number.isSafeInteger(tombstone.deletedAt)
    )
      throw new Error('SYNC_BUNDLE_INVALID')
    const key = recordKey(tombstone.domain, tombstone.recordId)
    if (tombstoneIds.has(key)) throw new Error('SYNC_BUNDLE_INVALID')
    if (scope && (tombstone as { workspaceId?: unknown }).workspaceId !== scope.workspaceId)
      throw new Error('SYNC_BUNDLE_WORKSPACE_MISMATCH')
    tombstoneIds.add(key)
  }
  if (
    manifest.tombstones !== bundle.tombstones.length ||
    Object.keys(manifest.domains).length !== Object.keys(domains).length ||
    Object.entries(domains).some(([domain, count]) => manifest.domains[domain] !== count) ||
    Object.values(manifest.domains).some((count) => !Number.isSafeInteger(count) || count < 0)
  )
    throw new Error('SYNC_BUNDLE_INVALID')

  const { contentHash, ...manifestBase } = manifest
  if (hashSyncBundleContent(manifestBase, bundle.records, bundle.tombstones) !== contentHash)
    throw new Error('SYNC_BUNDLE_HASH_MISMATCH')
  return bundle as SyncBundle
}

/** A v1 WebDAV bundle is untrusted input, even when it comes from a configured server. */
export function verifyLegacySyncBundle(value: unknown): SyncBundle {
  return verifySyncBundle(value)
}

/** V2 accepts only directly workspace-owned rows until relational ownership is implemented. */
export function verifyWorkspaceSyncBundle(
  value: unknown,
  scope: WorkspaceSyncScope
): WorkspaceSyncBundle {
  return verifySyncBundle(value, scope) as WorkspaceSyncBundle
}
