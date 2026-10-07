import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { waitForWindowsSafeStorageKeyFile } from '../../src/main/credentials/safe-storage-key-persistence'

describe('Windows safeStorage key persistence', () => {
  it('waits for Chromium to write a complete encrypted key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-safe-storage-key-'))
    const path = join(root, 'Local State')
    try {
      await writeFile(path, JSON.stringify({ os_crypt: {} }))
      const wait = waitForWindowsSafeStorageKeyFile(path, 1_000)
      await new Promise((resolveWait) => setTimeout(resolveWait, 75))
      await writeFile(path, JSON.stringify({ os_crypt: { encrypted_key: 'test-key' } }))
      await expect(wait).resolves.toBeUndefined()
      expect((await readFile(path, 'utf8')).includes('test-key')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when the key file is never written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-safe-storage-key-missing-'))
    try {
      await expect(waitForWindowsSafeStorageKeyFile(join(root, 'Local State'), 60)).rejects.toThrow(
        'key was not persisted'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
