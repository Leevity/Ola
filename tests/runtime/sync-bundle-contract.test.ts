import { expect, it } from 'vitest'
import type { SyncBundle, SyncBundleManifest } from '../../src/shared/sync-types'
import {
  hashSyncBundleContent,
  hashSyncRecordValue,
  verifyLegacySyncBundle
} from '../../src/shared/sync-bundle-contract'

function bundle(): SyncBundle {
  const value = { table: 'desktop_flows', row: { id: 'flow-a', workspace_id: 'local-personal' } }
  const records = [
    {
      domain: 'db:desktop_flows',
      recordId: 'flow-a',
      hash: hashSyncRecordValue(value),
      value,
      updatedAt: 1
    }
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

it('accepts a valid legacy bundle and rejects corrupted content', () => {
  const valid = bundle()
  expect(verifyLegacySyncBundle(valid)).toEqual(valid)
  const changed = structuredClone(valid)
  changed.records[0].value = { table: 'desktop_flows', row: { id: 'other' } }
  expect(() => verifyLegacySyncBundle(changed)).toThrow('SYNC_BUNDLE_INVALID')
  const manifestHash = bundle()
  manifestHash.manifest.createdAt = 2
  expect(() => verifyLegacySyncBundle(manifestHash)).toThrow('SYNC_BUNDLE_HASH_MISMATCH')
})

it('rejects incompatible versions, duplicate keys and forged domain counts', () => {
  const version = bundle()
  version.manifest.schemaVersion = 2
  expect(() => verifyLegacySyncBundle(version)).toThrow('SYNC_BUNDLE_INVALID')
  const duplicate = bundle()
  duplicate.records.push(duplicate.records[0])
  expect(() => verifyLegacySyncBundle(duplicate)).toThrow('SYNC_BUNDLE_INVALID')
  const count = bundle()
  count.manifest.domains['db:desktop_flows'] = 2
  expect(() => verifyLegacySyncBundle(count)).toThrow('SYNC_BUNDLE_INVALID')
})

it('rejects team workspace rows even with a recomputed content hash', () => {
  const remote = bundle()
  remote.records[0].value = {
    table: 'desktop_flows',
    row: { id: 'flow-a', workspace_id: 'team-a' }
  }
  remote.records[0].hash = hashSyncRecordValue(remote.records[0].value)
  const { contentHash: _ignored, ...manifestBase } = remote.manifest
  remote.manifest.contentHash = hashSyncBundleContent(
    manifestBase,
    remote.records,
    remote.tombstones
  )
  expect(() => verifyLegacySyncBundle(remote)).toThrow('LEGACY_SYNC_TEAM_WORKSPACE_UNSUPPORTED')
})
