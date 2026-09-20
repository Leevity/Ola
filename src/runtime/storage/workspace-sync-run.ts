import type {
  SyncConflict,
  SyncConflictResolution,
  WebDavSyncConfig,
  WorkspaceSyncBundle,
  WorkspaceSyncScope
} from '../../shared/sync-types'
import { verifyWorkspaceSyncBundle } from '../../shared/sync-bundle-contract'
import type { BusinessRepository } from './business-repository'
import { mergeWorkspaceBundles } from './workspace-sync-merge'
import { captureWorkspaceSyncState } from './workspace-sync'

interface RemoteState {
  bundle: WorkspaceSyncBundle | null
  etag: string | null
  lastModified: string | null
  updatedAt: number | null
}

interface WorkspaceSyncTransport {
  downloadWorkspace(config: WebDavSyncConfig, scope: WorkspaceSyncScope): Promise<RemoteState>
  uploadWorkspace(
    config: WebDavSyncConfig,
    scope: WorkspaceSyncScope,
    bundle: WorkspaceSyncBundle,
    options: {
      previousExists: boolean
      previousEtag: string | null
      previousLastModified: string | null
    }
  ): Promise<RemoteState>
}

export type WorkspaceSyncRunResult =
  | { status: 'conflict'; conflicts: SyncConflict[] }
  | {
      status: 'success'
      uploadedRecords: number
      downloadedRecords: number
      deletedRecords: number
      remoteEtag: string | null
    }

/** Full workspace-scoped sync. Authorization is deliberately rechecked at every boundary. */
export async function runWorkspaceSync(input: {
  repository: Pick<BusinessRepository, 'captureWorkspaceSyncSnapshot' | 'commitWorkspaceSync'>
  transport: WorkspaceSyncTransport
  config: WebDavSyncConfig
  scope: WorkspaceSyncScope
  providerId: string
  deviceId: string
  appVersion: string
  createdAt: number
  resolutions?: SyncConflictResolution[]
  authorize: () => Promise<void>
}): Promise<WorkspaceSyncRunResult> {
  await input.authorize()
  const captured = await captureWorkspaceSyncState({
    repository: input.repository,
    scope: input.scope,
    providerId: input.providerId,
    deviceId: input.deviceId,
    appVersion: input.appVersion,
    createdAt: input.createdAt,
    authorize: input.authorize
  })
  await input.authorize()
  const remote = await input.transport.downloadWorkspace(input.config, input.scope)
  await input.authorize()
  const merge = mergeWorkspaceBundles({
    scope: input.scope,
    local: captured.bundle,
    remote: remote.bundle,
    baseline: captured.baseline,
    resolutions: input.resolutions,
    createdAt: input.createdAt
  })
  if (merge.status === 'conflict') return merge
  await input.authorize()
  const uploaded = await input.transport.uploadWorkspace(input.config, input.scope, merge.bundle, {
    previousExists: remote.bundle !== null,
    previousEtag: remote.etag,
    previousLastModified: remote.lastModified
  })
  if (
    !uploaded.bundle ||
    verifyWorkspaceSyncBundle(uploaded.bundle, input.scope).manifest.contentHash !==
      merge.bundle.manifest.contentHash
  )
    throw new Error('SYNC_REMOTE_CONFIRMATION_MISMATCH')
  await input.authorize()
  const committed = await input.repository.commitWorkspaceSync({
    scopeHash: captured.scopeHash,
    workspaceId: input.scope.workspaceId,
    providerId: input.providerId,
    expectedRevisionToken: captured.revisionToken,
    syncedAt: input.createdAt,
    records: merge.bundle.records,
    deleted: merge.deleted,
    expectedBundle: merge.bundle,
    baseline: merge.bundle.records.map((record) => ({
      domain: record.domain,
      recordId: record.recordId,
      contentHash: record.hash
    })),
    tombstones: merge.bundle.tombstones
  })
  return {
    status: 'success',
    uploadedRecords: merge.bundle.records.length,
    downloadedRecords: committed.saved,
    deletedRecords: committed.deleted,
    remoteEtag: uploaded.etag
  }
}
