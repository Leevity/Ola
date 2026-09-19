import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SyncFileStore } from '../../src/main/sync/sync-file-store'
import { SettingsStore } from '../../src/main/settings/settings-store'

describe('SyncFileStore', () => {
  it('removes secrets from snapshots and preserves local secrets on apply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-sync-file-'))
    const path = join(root, 'settings.json')
    try {
      await writeFile(
        path,
        JSON.stringify({ public: 'old', nested: { apiKey: 'local-secret' } }),
        'utf8'
      )
      const store = new SyncFileStore(new SettingsStore(path), path)
      const [record] = await store.capture()
      expect(
        Buffer.from((record.value as { data: string }).data, 'base64').toString('utf8')
      ).not.toContain('local-secret')
      record.value = {
        path: 'settings.json',
        data: Buffer.from(
          JSON.stringify({ public: 'remote', nested: { apiKey: 'remote-secret' } })
        ).toString('base64')
      }
      await store.apply([record])
      await expect(readFile(path, 'utf8')).resolves.toContain('local-secret')
      await expect(readFile(path, 'utf8')).resolves.toContain('remote')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
