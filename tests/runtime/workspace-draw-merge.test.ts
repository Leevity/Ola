import { expect, it, vi } from 'vitest'
import type { WorkspaceSyncBundle, WorkspaceSyncScope } from '../../src/shared/sync-types'
import {
  hashSyncBundleContent,
  hashSyncRecordValue,
  workspaceSyncScopeHash
} from '../../src/shared/sync-bundle-contract'
import { mergeWorkspaceDrawBundles } from '../../src/runtime/storage/workspace-draw-merge'
import { runWorkspaceDrawSync } from '../../src/runtime/storage/workspace-draw-sync-run'

const scope: WorkspaceSyncScope = {
  apiBaseUrl: 'https://ola.example.invalid',
  accountId: 'account-a',
  workspaceId: 'team-a'
}
const domain = 'db:draw_runs'

function record(id: string, prompt: string) {
  const value = {
    table: 'draw_runs',
    row: {
      id,
      workspace_id: scope.workspaceId,
      prompt,
      provider_name: 'Provider',
      model_name: 'Model',
      mode: 'image',
      meta_json: null,
      created_at: 1,
      is_generating: 0,
      images_json: '[]',
      error_json: null,
      updated_at: 1
    }
  }
  return { domain, recordId: id, hash: hashSyncRecordValue(value), value }
}

function bundle(
  records: ReturnType<typeof record>[] = [],
  deleted: Array<{ id: string; at: number }> = []
): WorkspaceSyncBundle {
  const tombstones = deleted.map(({ id, at }) => ({
    domain,
    recordId: id,
    deletedAt: at,
    originDeviceId: 'device-b',
    workspaceId: scope.workspaceId
  }))
  const manifest = {
    schemaVersion: 2 as const,
    appVersion: '1.0.5',
    deviceId: 'device-a',
    createdAt: 10,
    scopeHash: workspaceSyncScopeHash(scope),
    domains: records.length ? { [domain]: records.length } : ({} as Record<string, number>),
    tombstones: tombstones.length
  }
  return {
    manifest: { ...manifest, contentHash: hashSyncBundleContent(manifest, records, tombstones) },
    records,
    tombstones
  }
}

function merge(
  local: WorkspaceSyncBundle,
  remote: WorkspaceSyncBundle | null,
  baseline: ReturnType<typeof record>[] = [],
  resolutions?: Array<{ conflictId: string; choice: 'local' | 'remote' }>
) {
  return mergeWorkspaceDrawBundles({
    scope,
    local,
    remote,
    baseline: baseline.map((row) => ({
      domain,
      recordId: row.recordId,
      contentHash: row.hash
    })),
    resolutions,
    createdAt: 20
  })
}

it('selects the changed side and computes only necessary local writes', () => {
  const old = record('draw-a', 'old')
  const changed = record('draw-a', 'remote change')
  const result = merge(bundle([old]), bundle([changed]), [old])
  expect(result.status).toBe('ready')
  if (result.status !== 'ready') return
  expect(result.recordsToApply).toEqual([changed])
  expect(result.deletedIds).toEqual([])
  expect(result.bundle.records).toEqual([changed])
  expect(merge(bundle([changed]), bundle([old]), [old])).toMatchObject({
    status: 'ready',
    recordsToApply: []
  })
})

it('preserves a scoped deletion and applies a remote deletion of unchanged local data', () => {
  const old = record('draw-a', 'old')
  const result = merge(bundle([old]), bundle([], [{ id: 'draw-a', at: 12 }]), [old])
  expect(result).toMatchObject({ status: 'ready', deletedIds: ['draw-a'] })
  if (result.status !== 'ready') return
  expect(result.bundle.tombstones[0].workspaceId).toBe('team-a')
  expect(result.bundle.tombstones[0].deletedAt).toBe(12)
  expect(merge(bundle([], [{ id: 'draw-a', at: 11 }]), bundle([old]), [old])).toMatchObject({
    status: 'ready',
    recordsToApply: []
  })
})

it('blocks concurrent edits and delete-versus-modify until an explicit choice', () => {
  const old = record('draw-a', 'old')
  const local = bundle([record('draw-a', 'local')])
  const remote = bundle([record('draw-a', 'remote')])
  const pending = merge(local, remote, [old])
  expect(pending).toMatchObject({
    status: 'conflict',
    conflicts: [{ kind: 'modify-modify', recordId: 'draw-a' }]
  })
  if (pending.status !== 'conflict') return
  expect(
    merge(local, remote, [old], [{ conflictId: pending.conflicts[0].id, choice: 'remote' }])
  ).toMatchObject({ status: 'ready', recordsToApply: remote.records })
  expect(merge(local, bundle([], [{ id: 'draw-a', at: 12 }]), [old])).toMatchObject({
    status: 'conflict',
    conflicts: [{ kind: 'delete-modify' }]
  })
  expect(
    merge(bundle([record('draw-a', 'local')]), bundle([record('draw-a', 'remote')]))
  ).toMatchObject({
    status: 'conflict',
    conflicts: [{ kind: 'create-create' }]
  })
})

it('rejects a resolution after either side of the conflict changes', () => {
  const old = record('draw-a', 'old')
  const local = bundle([record('draw-a', 'local')])
  const remote = bundle([record('draw-a', 'remote')])
  const pending = merge(local, remote, [old])
  if (pending.status !== 'conflict') throw new Error('Expected a conflict')
  const resolution = [{ conflictId: pending.conflicts[0].id, choice: 'remote' as const }]

  expect(() => merge(local, bundle([record('draw-a', 'new remote')]), [old], resolution)).toThrow(
    'SYNC_DRAW_RESOLUTION_INVALID'
  )
  expect(() => merge(bundle([record('draw-a', 'new local')]), remote, [old], resolution)).toThrow(
    'SYNC_DRAW_RESOLUTION_INVALID'
  )

  const deleted = bundle([], [{ id: 'draw-a', at: 12 }])
  const deletionConflict = merge(local, deleted, [old])
  if (deletionConflict.status !== 'conflict') throw new Error('Expected a deletion conflict')
  expect(() =>
    merge(
      local,
      bundle([], [{ id: 'draw-a', at: 13 }]),
      [old],
      [{ conflictId: deletionConflict.conflicts[0].id, choice: 'local' }]
    )
  ).toThrow('SYNC_DRAW_RESOLUTION_INVALID')
})

it('fails closed when a baseline record disappears without a tombstone', () => {
  const old = record('draw-a', 'old')
  expect(() => merge(bundle([old]), bundle(), [old])).toThrow('SYNC_REMOTE_BASELINE_MISSING')
  expect(() => merge(bundle([old]), null, [old])).toThrow('SYNC_REMOTE_BASELINE_MISSING')
  expect(() => merge(bundle(), bundle([old]), [old])).toThrow('SYNC_LOCAL_BASELINE_MISSING')
})

it('rejects cross-space bundles before merge decisions', () => {
  const outside = bundle([record('draw-a', 'old')])
  outside.records[0].value = {
    table: 'draw_runs',
    row: { id: 'draw-a', workspace_id: 'team-b', prompt: 'old' }
  }
  outside.records[0].hash = hashSyncRecordValue(outside.records[0].value)
  const { contentHash: _ignored, ...manifest } = outside.manifest
  outside.manifest.contentHash = hashSyncBundleContent(
    manifest,
    outside.records,
    outside.tombstones
  )
  expect(() => merge(bundle(), outside)).toThrow('SYNC_BUNDLE_WORKSPACE_MISMATCH')
})

it('rejects a hash-valid but unwritable draw row before producing an upload plan', () => {
  const old = record('draw-a', 'old')
  const local = bundle([old])
  const remote = bundle([record('draw-a', 'changed')])
  const value = remote.records[0].value as { row: { images_json: string } }
  value.row.images_json = '{broken'
  remote.records[0].hash = hashSyncRecordValue(value)
  const { contentHash: _ignored, ...manifest } = remote.manifest
  remote.manifest.contentHash = hashSyncBundleContent(manifest, remote.records, remote.tombstones)
  expect(() => merge(local, remote, [old])).toThrow('SYNC_DRAW_ROW_INVALID')
})

it('does not commit a team sync baseline when authorization is revoked during upload', async () => {
  let authorized = true
  const commitWorkspaceDrawSync = vi.fn()
  const repository = {
    captureWorkspaceDrawSyncSnapshot: vi.fn(async () => ({
      rows: [],
      tombstones: [],
      baseline: [],
      revisionToken: 'a'.repeat(64)
    })),
    validateWorkspaceDrawSyncIds: vi.fn(async () => undefined),
    commitWorkspaceDrawSync
  } as unknown as Parameters<typeof runWorkspaceDrawSync>[0]['repository']
  const transport = {
    downloadWorkspace: vi.fn(async () => ({
      bundle: null,
      etag: null,
      lastModified: null,
      updatedAt: null
    })),
    uploadWorkspace: vi.fn(async (_config, _scope, uploaded: WorkspaceSyncBundle) => {
      authorized = false
      return { bundle: uploaded, etag: 'etag-a', lastModified: null, updatedAt: null }
    })
  } as unknown as Parameters<typeof runWorkspaceDrawSync>[0]['transport']
  await expect(
    runWorkspaceDrawSync({
      repository,
      transport,
      config: {
        displayName: 'Test',
        serverUrl: 'https://dav.example.invalid',
        username: '',
        password: '',
        remoteDir: 'ola-sync',
        autoSyncEnabled: false,
        syncIntervalMinutes: 30,
        backupRetention: 0
      },
      scope,
      providerId: 'webdav',
      deviceId: 'device-a',
      appVersion: '1.0.5',
      createdAt: 10,
      authorize: async () => {
        if (!authorized) throw new Error('TEAM_REVOKED')
      }
    })
  ).rejects.toThrow('TEAM_REVOKED')
  expect(transport.uploadWorkspace).toHaveBeenCalledOnce()
  expect(commitWorkspaceDrawSync).not.toHaveBeenCalled()
})
