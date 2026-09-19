import { afterEach, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import type { SyncBundle, SyncBundleManifest, WebDavSyncConfig } from '../../src/shared/sync-types'
import { hashSyncBundleContent, hashSyncRecordValue } from '../../src/shared/sync-bundle-contract'
import { readBoundedBody, WebDavProvider } from '../../src/main/sync/webdav-provider'

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

function remoteBundle(): SyncBundle {
  const value = { row: { id: 'flow-a', workspace_id: 'local-personal' }, table: 'desktop_flows' }
  const records = [
    { domain: 'db:desktop_flows', recordId: 'flow-a', hash: hashSyncRecordValue(value), value }
  ]
  const manifest: Omit<SyncBundleManifest, 'contentHash'> = {
    schemaVersion: 1,
    appVersion: '1.0.5',
    deviceId: 'device-a',
    createdAt: 1,
    domains: { 'db:desktop_flows': 1 },
    tombstones: 0
  }
  return {
    manifest: { ...manifest, contentHash: hashSyncBundleContent(manifest, records, []) },
    records,
    tombstones: []
  }
}

function stubDownload(bundle: SyncBundle): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === 'MKCOL') return new Response(null, { status: 201 })
      if (options.method === 'PROPFIND') {
        return new Response('<d:getetag>"etag-a"</d:getetag>', { status: 207 })
      }
      if (options.method === 'GET') {
        return new Response(gzipSync(JSON.stringify(bundle)), { status: 200 })
      }
      throw new Error('Unexpected WebDAV request')
    })
  )
}

afterEach(() => vi.unstubAllGlobals())

it('validates a downloaded bundle before returning it to the sync engine', async () => {
  const valid = remoteBundle()
  stubDownload(valid)
  await expect(new WebDavProvider().download(config)).resolves.toMatchObject({ bundle: valid })
  valid.manifest.createdAt = 2
  stubDownload(valid)
  await expect(new WebDavProvider().download(config)).rejects.toThrow('SYNC_BUNDLE_HASH_MISMATCH')
})

it('bounds a streamed remote body before allocating the full response', async () => {
  const response = new Response(new Uint8Array([1, 2, 3, 4]))
  await expect(readBoundedBody(response, 3)).rejects.toThrow('SYNC_BUNDLE_TOO_LARGE')
})
