import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EncryptedExtensionSecretStore,
  type ExtensionSecretCryptography
} from '../../src/main/extensions/extension-secret-store'

const crypto: ExtensionSecretCryptography = {
  available: () => true,
  encrypt: (value) => Buffer.from('encrypted:' + Buffer.from(value).toString('base64')),
  decrypt: (value) => Buffer.from(value.toString().replace(/^encrypted:/, ''), 'base64').toString()
}

describe('extension secret store', () => {
  it('persists encrypted copies without removing a legacy Worker secret during coexistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-extension-secret-'))
    const path = join(root, 'extensions-secrets.bin')
    const legacy = new Map<string, unknown>([['extension:sample:secret:token', 'legacy-value']])
    try {
      const store = new EncryptedExtensionSecretStore(path, crypto, {
        get: async (key) => legacy.get(key),
        delete: async (key) => void legacy.delete(key)
      })
      await expect(store.get('sample', 'token')).resolves.toBe('legacy-value')
      expect(legacy.get('extension:sample:secret:token')).toBe('legacy-value')
      await store.set('sample', 'token', 'new-value')
      await expect(readFile(path, 'utf8')).resolves.not.toContain('new-value')
      const reopened = new EncryptedExtensionSecretStore(path, crypto)
      await expect(reopened.get('sample', 'token')).resolves.toBe('new-value')
      await reopened.delete('sample', 'token')
      await expect(reopened.get('sample', 'token')).resolves.toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps secrets only in memory when encryption is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-extension-secret-memory-'))
    const path = join(root, 'extensions-secrets.bin')
    const unavailable: ExtensionSecretCryptography = { ...crypto, available: () => false }
    try {
      const store = new EncryptedExtensionSecretStore(path, unavailable)
      await store.set('sample', 'token', 'session-value')
      await expect(store.get('sample', 'token')).resolves.toBe('session-value')
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
