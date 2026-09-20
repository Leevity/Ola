import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  repository: {
    syncCaptureLocal: vi.fn(),
    syncApplyDbMerge: vi.fn(),
    syncSaveMetadata: vi.fn()
  }
}))

vi.mock('../../src/main/db/business-write-canary', () => ({
  businessWriteCanary: () => state.repository,
  getTsDatabaseRouteGuard: () => {
    throw new Error('TS sync DAO unexpectedly entered legacy route')
  }
}))

import {
  applySyncDbMerge,
  captureSyncDbSnapshot,
  saveSyncDbMetadata
} from '../../src/main/db/sync-dao'

beforeEach(() => {
  state.repository.syncCaptureLocal.mockReset()
  state.repository.syncApplyDbMerge.mockReset()
  state.repository.syncSaveMetadata.mockReset()
  state.repository.syncCaptureLocal.mockResolvedValue({ records: [], baseline: [], tombstones: [] })
  state.repository.syncApplyDbMerge.mockResolvedValue({ success: true, changed: 2 })
  state.repository.syncSaveMetadata.mockResolvedValue({ success: true, changed: 2 })
})

it('captures a TS-owned workspace sync snapshot', async () => {
  const snapshot = {
    records: [{ domain: 'settings', recordId: 'a', value: { enabled: true }, hash: 'hash-a' }],
    baseline: [{ domain: 'settings', recordId: 'a', contentHash: 'hash-a' }],
    tombstones: []
  }
  state.repository.syncCaptureLocal.mockResolvedValue(snapshot)

  await expect(captureSyncDbSnapshot('webdav-a')).resolves.toEqual(snapshot)
  expect(state.repository.syncCaptureLocal).toHaveBeenCalledWith('webdav-a')
})

it('applies and records sync metadata through the TS repository', async () => {
  const recordsToApply = [
    { domain: 'settings', recordId: 'a', value: { enabled: true }, hash: 'hash-a' }
  ]
  const recordsToDelete = [{ domain: 'settings', recordId: 'old-a', originDeviceId: 'device-a' }]
  await applySyncDbMerge({ recordsToApply, recordsToDelete })
  await saveSyncDbMetadata(
    'webdav-a',
    [{ domain: 'settings', recordId: 'a', hash: 'hash-a' }],
    [{ domain: 'settings', recordId: 'old-a', deletedAt: 1, originDeviceId: 'device-a' }]
  )

  expect(state.repository.syncApplyDbMerge).toHaveBeenCalledWith({
    recordsToApply,
    recordsToDelete
  })
  expect(state.repository.syncSaveMetadata).toHaveBeenCalledWith({
    providerId: 'webdav-a',
    records: [{ domain: 'settings', recordId: 'a', hash: 'hash-a' }],
    tombstones: [
      { domain: 'settings', recordId: 'old-a', deletedAt: 1, originDeviceId: 'device-a' }
    ]
  })
})
