import type {
  SyncConflict,
  SyncConflictResolution,
  WebDavSyncConfig,
  WorkspaceSyncBundle,
  WorkspaceSyncScope
} from '../../shared/sync-types'
import { verifyWorkspaceSyncBundle } from '../../shared/sync-bundle-contract'
import type { BusinessRepository } from './business-repository'
import { mergeWorkspaceDrawBundles } from './workspace-draw-merge'
import { captureWorkspaceDrawState, commitWorkspaceDrawMerge } from './workspace-draw-sync'

interface RemoteState {
  bundle: WorkspaceSyncBundle | null
  etag: string | null
  lastModified: string | null
  updatedAt: number | null
}

interface WorkspaceDrawTransport {
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

export type WorkspaceDrawSyncRunResult =
  | { status: 'conflict'; conflicts: SyncConflict[] }
  | {
      status: 'success'
      uploadedRecords: number
      downloadedRecords: number
      deletedRecords: number
      remoteEtag: string | null
    }

/** Staged draw-only flow. The caller owns account/workspace authorization and scheduling. */
export async function runWorkspaceDrawSync(input: {
  repository: Pick<
    BusinessRepository,
    'captureWorkspaceDrawSyncSnapshot' | 'commitWorkspaceDrawSync' | 'validateWorkspaceDrawSyncIds'
  >
  transport: WorkspaceDrawTransport
  config: WebDavSyncConfig
  scope: WorkspaceSyncScope
  providerId: string
  deviceId: string
  appVersion: string
  createdAt: number
  resolutions?: SyncConflictResolution[]
  authorize: () => Promise<void>
}): Promise<WorkspaceDrawSyncRunResult> {
  await input.authorize()
  const captured = await captureWorkspaceDrawState(input)
  await input.authorize()
  const remote = await input.transport.downloadWorkspace(input.config, input.scope)
  await input.authorize()
  const merge = mergeWorkspaceDrawBundles({
    scope: input.scope,
    local: captured.bundle,
    remote: remote.bundle,
    baseline: captured.baseline,
    resolutions: input.resolutions,
    createdAt: input.createdAt
  })
  if (merge.status === 'conflict') return { status: 'conflict', conflicts: merge.conflicts }
  await input.authorize()
  await input.repository.validateWorkspaceDrawSyncIds(
    input.scope.workspaceId,
    [...merge.bundle.records, ...merge.bundle.tombstones].map((item) => item.recordId)
  )
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
    throw new Error('SYNC_DRAW_REMOTE_CONFIRMATION_MISMATCH')
  await input.authorize()
  const committed = await commitWorkspaceDrawMerge({
    repository: input.repository,
    scope: input.scope,
    providerId: input.providerId,
    captured,
    merge,
    syncedAt: input.createdAt,
    authorize: input.authorize
  })
  return {
    status: 'success',
    uploadedRecords: merge.bundle.records.length,
    downloadedRecords: committed.saved,
    deletedRecords: committed.deleted,
    remoteEtag: uploaded.etag
  }
}
