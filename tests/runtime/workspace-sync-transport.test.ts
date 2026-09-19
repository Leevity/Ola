import { afterEach, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import type {
  WebDavSyncConfig,
  WorkspaceSyncBundle,
  WorkspaceSyncScope
} from '../../src/shared/sync-types'
import {
  hashSyncBundleContent,
  hashSyncRecordValue,
  verifyWorkspaceSyncBundle,
  workspaceSyncScopeHash
} from '../../src/shared/sync-bundle-contract'
import {
  RemoteStateChangedError,
  WebDavProvider,
  workspaceWebDavConfig
} from '../../src/main/sync/webdav-provider'

const scope: WorkspaceSyncScope = {
  accountId: 'account-a',
  apiBaseUrl: 'https://ola.example.invalid',
  workspaceId: 'team-a'
}
const config: WebDavSyncConfig = {
  displayName: 'Test',
  serverUrl: 'https://example.invalid/dav',
  username: '',
  password: '',
  remoteDir: 'ola-sync/v1',
  autoSyncEnabled: false,
  syncIntervalMinutes: 30,
  backupRetention: 0
}

function bundle(input: WorkspaceSyncScope = scope): WorkspaceSyncBundle {
  const value = { table: 'desktop_flows', row: { id: 'flow-a', workspace_id: input.workspaceId } }
  const records = [
    { domain: 'db:desktop_flows', recordId: 'flow-a', hash: hashSyncRecordValue(value), value }
  ]
  const tombstones = [
    {
      domain: 'db:desktop_flows',
      recordId: 'flow-old',
      deletedAt: 1,
      originDeviceId: 'device-a',
      workspaceId: input.workspaceId
    }
  ]
  const manifest: Omit<WorkspaceSyncBundle['manifest'], 'contentHash'> = {
    schemaVersion: 2,
    appVersion: '1.0.5',
    deviceId: 'device-a',
    createdAt: 1,
    scopeHash: workspaceSyncScopeHash(input),
    domains: { 'db:desktop_flows': 1 },
    tombstones: 1
  }
  return {
    manifest: { ...manifest, contentHash: hashSyncBundleContent(manifest, records, tombstones) },
    records,
    tombstones
  }
}

afterEach(() => vi.unstubAllGlobals())

it('separates remote paths by account and workspace without exposing raw IDs', () => {
  const first = workspaceWebDavConfig(config, scope).remoteDir
  expect(first).toContain('/workspaces-v2/')
  expect(first).not.toContain(scope.accountId)
  expect(first).not.toContain(scope.workspaceId)
  expect(workspaceWebDavConfig(config, { ...scope, workspaceId: 'team-b' }).remoteDir).not.toBe(
    first
  )
  expect(workspaceWebDavConfig(config, { ...scope, accountId: 'account-b' }).remoteDir).not.toBe(
    first
  )
  expect(
    workspaceWebDavConfig(config, { ...scope, apiBaseUrl: 'https://another.invalid' }).remoteDir
  ).not.toBe(first)
  expect(
    workspaceWebDavConfig(config, { ...scope, apiBaseUrl: `${scope.apiBaseUrl}/` }).remoteDir
  ).toBe(first)
  expect(() => workspaceWebDavConfig(config, { ...scope, apiBaseUrl: 'file:///tmp' })).toThrow(
    'SYNC_WORKSPACE_SCOPE_INVALID'
  )
  expect(() => workspaceWebDavConfig({ ...config, remoteDir: '../shared' }, scope)).toThrow(
    'SYNC_REMOTE_PATH_INVALID'
  )
})

it('rejects another account, workspace or unscoped row before applying a v2 bundle', () => {
  const valid = bundle()
  expect(verifyWorkspaceSyncBundle(valid, scope)).toEqual(valid)
  expect(() => verifyWorkspaceSyncBundle(valid, { ...scope, accountId: 'account-b' })).toThrow(
    'SYNC_BUNDLE_INVALID'
  )
  expect(() => verifyWorkspaceSyncBundle(valid, { ...scope, workspaceId: 'team-b' })).toThrow(
    'SYNC_BUNDLE_INVALID'
  )
  const unscoped = bundle()
  delete (unscoped.records[0].value as { row: { workspace_id?: string } }).row.workspace_id
  unscoped.records[0].hash = hashSyncRecordValue(unscoped.records[0].value)
  const { contentHash: _hash, ...manifestBase } = unscoped.manifest
  unscoped.manifest.contentHash = hashSyncBundleContent(
    manifestBase,
    unscoped.records,
    unscoped.tombstones
  )
  expect(() => verifyWorkspaceSyncBundle(unscoped, scope)).toThrow('SYNC_BUNDLE_WORKSPACE_MISMATCH')
})

it('downloads only the hashed workspace path and validates bundle identity', async () => {
  const valid = bundle()
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      urls.push(url)
      if (options.method === 'MKCOL') return new Response(null, { status: 201 })
      if (options.method === 'PROPFIND')
        return new Response('<d:getetag>"e"</d:getetag>', { status: 207 })
      if (options.method === 'GET') {
        return new Response(gzipSync(JSON.stringify(valid)), { status: 200 })
      }
      throw new Error('Unexpected request')
    })
  )
  await expect(new WebDavProvider().downloadWorkspace(config, scope)).resolves.toMatchObject({
    bundle: valid
  })
  expect(urls.some((url) => url.includes(`/workspaces-v2/${workspaceSyncScopeHash(scope)}/`))).toBe(
    true
  )
  expect(urls.every((url) => !url.includes('team-a') && !url.includes('account-a'))).toBe(true)
})

it('rejects a wrong-scope upload before sending any WebDAV request', async () => {
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  await expect(
    new WebDavProvider().uploadWorkspace(config, scope, bundle({ ...scope, workspaceId: 'team-b' }))
  ).rejects.toThrow('SYNC_BUNDLE_INVALID')
  expect(request).not.toHaveBeenCalled()
})

it('uploads a v2 bundle only to its scoped path with a conditional create', async () => {
  const valid = bundle()
  const statePath = `/workspaces-v2/${workspaceSyncScopeHash(scope)}/state.json.gz`
  let uploaded = false
  const writes: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      if (options.method === 'MKCOL') return new Response(null, { status: 201 })
      if (options.method === 'PROPFIND') {
        if (url.endsWith('state.json.gz') && uploaded)
          return new Response('<d:getetag>"e"</d:getetag>', { status: 207 })
        return new Response(null, { status: 404 })
      }
      if (options.method === 'PUT') {
        expect(url).toContain(statePath)
        expect((options.headers as Record<string, string>)['If-None-Match']).toBe('*')
        writes.push(url)
        uploaded = true
        return new Response(null, { status: 201 })
      }
      if (options.method === 'GET') {
        expect(url).toContain(statePath)
        return new Response(gzipSync(JSON.stringify(valid)), { status: 200 })
      }
      throw new Error('Unexpected request')
    })
  )
  await expect(
    new WebDavProvider().uploadWorkspace(config, scope, valid, { previousExists: false })
  ).resolves.toMatchObject({ bundle: valid })
  expect(writes).toHaveLength(1)
})

it('requires a strong remote ETag before replacing a v2 workspace bundle', async () => {
  const valid = bundle()
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  const provider = new WebDavProvider()
  await expect(provider.uploadWorkspace(config, scope, valid)).rejects.toThrow(
    'SYNC_REMOTE_CONDITIONAL_WRITE_UNAVAILABLE'
  )
  await expect(
    provider.uploadWorkspace(config, scope, valid, { previousExists: true })
  ).rejects.toThrow('SYNC_REMOTE_CONDITIONAL_WRITE_UNAVAILABLE')
  await expect(
    provider.uploadWorkspace(config, scope, valid, {
      previousExists: true,
      previousEtag: 'W/etag-a'
    })
  ).rejects.toThrow('SYNC_REMOTE_CONDITIONAL_WRITE_UNAVAILABLE')
  expect(request).not.toHaveBeenCalled()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === 'MKCOL') return new Response(null, { status: 201 })
      if (options.method === 'PROPFIND')
        return new Response('<d:getetag>"etag-b"</d:getetag>', { status: 207 })
      throw new Error('A changed remote must not be overwritten')
    })
  )
  await expect(
    provider.uploadWorkspace(config, scope, valid, {
      previousExists: true,
      previousEtag: 'etag-a'
    })
  ).rejects.toBeInstanceOf(RemoteStateChangedError)
})

it('replaces an existing v2 bundle only with If-Match', async () => {
  const valid = bundle()
  let etag = 'etag-a'
  let uploads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === 'MKCOL') return new Response(null, { status: 201 })
      if (options.method === 'PROPFIND')
        return new Response(`<d:getetag>"${etag}"</d:getetag>`, { status: 207 })
      if (options.method === 'PUT') {
        expect((options.headers as Record<string, string>)['If-Match']).toBe('"etag-a"')
        uploads += 1
        etag = 'etag-b'
        return new Response(null, { status: 204 })
      }
      if (options.method === 'GET')
        return new Response(gzipSync(JSON.stringify(valid)), { status: 200 })
      throw new Error('Unexpected request')
    })
  )
  await expect(
    new WebDavProvider().uploadWorkspace(config, scope, valid, {
      previousExists: true,
      previousEtag: 'etag-a'
    })
  ).resolves.toMatchObject({ bundle: valid })
  expect(uploads).toBe(1)
})
