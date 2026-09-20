import type { WorkspaceSyncBundle, WorkspaceSyncScope } from '../../shared/sync-types'
import {
  hashSyncBundleContent,
  hashSyncRecordValue,
  verifyWorkspaceSyncBundle,
  workspaceSyncScopeHash
} from '../../shared/sync-bundle-contract'
import type { BusinessRepository, BusinessWorkspaceSyncBaseline } from './business-repository'

export interface WorkspaceSyncCapturedState {
  scopeHash: string
  bundle: WorkspaceSyncBundle
  baseline: BusinessWorkspaceSyncBaseline[]
  revisionToken: string
}

export async function captureWorkspaceSyncState(input: {
  repository: Pick<BusinessRepository, 'captureWorkspaceSyncSnapshot'>
  scope: WorkspaceSyncScope
  providerId: string
  deviceId: string
  appVersion: string
  createdAt: number
  authorize: () => Promise<void>
}): Promise<WorkspaceSyncCapturedState> {
  await input.authorize()
  const scopeHash = workspaceSyncScopeHash(input.scope)
  const snapshot = await input.repository.captureWorkspaceSyncSnapshot({
    scopeHash,
    workspaceId: input.scope.workspaceId,
    providerId: input.providerId,
    deviceId: input.deviceId,
    appVersion: input.appVersion,
    createdAt: input.createdAt
  })
  const records = snapshot.records.map((draft) => ({
    ...draft,
    hash: hashSyncRecordValue(draft.value)
  }))
  const manifestBase: Omit<WorkspaceSyncBundle['manifest'], 'contentHash'> = {
    schemaVersion: 2,
    appVersion: input.appVersion,
    deviceId: input.deviceId,
    createdAt: input.createdAt,
    scopeHash,
    domains: records.reduce<Record<string, number>>((counts, record) => {
      counts[record.domain] = (counts[record.domain] ?? 0) + 1
      return counts
    }, {}),
    tombstones: snapshot.tombstones.length
  }
  const bundle = verifyWorkspaceSyncBundle(
    {
      manifest: {
        ...manifestBase,
        contentHash: hashSyncBundleContent(manifestBase, records, snapshot.tombstones)
      },
      records,
      tombstones: snapshot.tombstones
    },
    input.scope
  )
  await input.authorize()
  return { scopeHash, bundle, baseline: snapshot.baseline, revisionToken: snapshot.revisionToken }
}
