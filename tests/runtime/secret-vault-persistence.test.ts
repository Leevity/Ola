import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  app: {
    isReady: () => true,
    getPath: (name: string) =>
      name === 'sessionData' ? join(fixture.root, 'session-data') : fixture.root
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: (value: string) =>
      Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: (value: Buffer) => {
      const serialized = value.toString()
      if (!serialized.startsWith('encrypted:')) throw new Error('Invalid ciphertext')
      return Buffer.from(serialized.slice('encrypted:'.length), 'base64').toString()
    }
  }
}))

beforeEach(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'ola-credential-vault-'))
  await mkdir(join(fixture.root, 'session-data'))
  await writeFile(
    join(fixture.root, 'session-data', 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: 'test-key' } })
  )
  vi.resetModules()
})

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true })
})

describe('credential vault persistence', () => {
  it('stores an encrypted password and restores it after module reload', async () => {
    const vault = await import('../../src/main/credentials/secret-vault')
    const ref = await vault.storeCredential({
      domain: 'example.invalid',
      username: 'owner',
      password: 'test-password',
      source: 'manual'
    })
    const ciphertext = await readFile(join(fixture.root, 'credentials', 'vault.bin'), 'utf8')
    expect(ciphertext).not.toContain('test-password')
    vi.resetModules()
    const reopened = await import('../../src/main/credentials/secret-vault')
    expect(reopened.getPlaintextPassword(ref.id)).toBe('test-password')
  })

  it('does not overwrite a malformed encrypted vault or its index', async () => {
    const credentialsPath = join(fixture.root, 'credentials')
    await mkdir(credentialsPath)
    const index = JSON.stringify({ version: 1, entries: [] })
    const ciphertext = Buffer.from('encrypted:' + Buffer.from('{invalid-json').toString('base64'))
    await writeFile(join(credentialsPath, 'index.json'), index)
    await writeFile(join(credentialsPath, 'vault.bin'), ciphertext)
    const vault = await import('../../src/main/credentials/secret-vault')
    await expect(
      vault.storeCredential({
        domain: 'example.invalid',
        username: 'owner',
        password: 'new-password',
        source: 'manual'
      })
    ).rejects.toThrow()
    expect(await readFile(join(credentialsPath, 'vault.bin'))).toEqual(ciphertext)
    expect(await readFile(join(credentialsPath, 'index.json'), 'utf8')).toBe(index)
  })

  it('persists password updates and deletion across reloads', async () => {
    const vault = await import('../../src/main/credentials/secret-vault')
    const ref = await vault.storeCredential({
      domain: 'example.invalid',
      username: 'owner',
      password: 'first-password',
      source: 'manual'
    })
    await expect(
      vault.updateCredential(ref.id, { password: 'second-password' })
    ).resolves.toMatchObject({
      id: ref.id
    })
    vi.resetModules()
    const reopened = await import('../../src/main/credentials/secret-vault')
    expect(reopened.getPlaintextPassword(ref.id)).toBe('second-password')
    await expect(reopened.deleteCredential(ref.id)).resolves.toBe(true)
    vi.resetModules()
    const afterDelete = await import('../../src/main/credentials/secret-vault')
    expect(afterDelete.getCredentialRef(ref.id)).toBeNull()
    expect(afterDelete.getPlaintextPassword(ref.id)).toBeNull()
  })

  it('does not replace a malformed credential index', async () => {
    const credentialsPath = join(fixture.root, 'credentials')
    await mkdir(credentialsPath)
    await writeFile(join(credentialsPath, 'index.json'), '{invalid-json')
    const vault = await import('../../src/main/credentials/secret-vault')
    await expect(
      vault.storeCredential({
        domain: 'example.invalid',
        username: 'owner',
        password: 'new-password',
        source: 'manual'
      })
    ).rejects.toThrow()
    expect(await readFile(join(credentialsPath, 'index.json'), 'utf8')).toBe('{invalid-json')
  })
})
