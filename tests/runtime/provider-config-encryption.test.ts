import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const fixture = vi.hoisted(() => ({
  root: '/tmp/ola-provider-config-encryption-fixture',
  vault: new Map<string, string>(),
  persistent: true,
  vaultReadFailure: false
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => fixture.root },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined }
}))
vi.mock('../../src/main/lib/ola-data-root', () => ({ olaDataRoot: () => fixture.root }))
vi.mock('../../src/main/renderer-security', () => ({
  assertTrustedRendererIpcEvent: () => undefined,
  isTrustedRendererIpcEvent: () => true,
  registerTrustedRendererUrl: () => undefined
}))
vi.mock('../../src/main/providers/provider-secret-store', () => ({
  getProviderSecretStore: () => ({
    isPersistent: () => fixture.persistent,
    getAuthBundle: async (id: string) => {
      if (fixture.vaultReadFailure) throw new Error('simulated vault read failure')
      return fixture.vault.get(id) ?? ''
    },
    setAuthBundle: async (id: string, value: string) => {
      fixture.vault.set(id, value)
    },
    deleteAuthBundle: async (id: string) => {
      fixture.vault.delete(id)
    },
    get: async (id: string) => {
      const bundle = fixture.vault.get(id)
      return bundle ? ((JSON.parse(bundle) as { apiKey?: string }).apiKey ?? '') : ''
    }
  })
}))

import {
  getConfigValue,
  readConfig,
  setConfigValue,
  writeConfig
} from '../../src/main/ipc/secure-key-store'

const key = 'ola-providers'
const provider = (accessToken: string): Record<string, unknown> => ({
  state: {
    providers: [
      {
        id: 'codex',
        name: 'Codex',
        type: 'openai',
        apiKey: accessToken,
        baseUrl: 'https://example.invalid',
        enabled: true,
        models: [],
        authMode: 'oauth',
        activeAccountId: 'account-one',
        oauth: { accessToken, refreshToken: 'refresh-secret' },
        oauthAccounts: [
          { id: 'account-one', email: 'owner@example.invalid', oauth: { accessToken } }
        ]
      }
    ]
  },
  version: 1
})

beforeEach(async () => {
  await rm(fixture.root, { recursive: true, force: true })
  await mkdir(fixture.root, { recursive: true })
  fixture.vault.clear()
  fixture.persistent = true
  fixture.vaultReadFailure = false
})

describe('provider config credential boundary', () => {
  it('stores new credentials only in the vault and rehydrates provider reads', async () => {
    const input = provider('new-secret')
    expect(await setConfigValue(key, input)).toEqual({ success: true })
    const disk = await readFile(join(fixture.root, 'config.json'), 'utf8')
    expect(disk).toContain('owner@example.invalid')
    expect(disk).not.toContain('new-secret')
    expect(disk).not.toContain('refresh-secret')
    expect(fixture.vault.get('codex')).toContain('new-secret')
    expect(await getConfigValue(key)).toEqual(input)
  })

  it('migrates existing plaintext without losing provider fields', async () => {
    const input = provider('legacy-secret')
    await writeFile(join(fixture.root, 'config.json'), JSON.stringify({ [key]: input }))
    expect(await getConfigValue(key)).toEqual(input)
    const disk = await readFile(join(fixture.root, 'config.json'), 'utf8')
    expect(disk).not.toContain('legacy-secret')
    expect(fixture.vault.get('codex')).toContain('legacy-secret')
  })

  it('restores the previous vault snapshot when config commit fails', async () => {
    expect(await setConfigValue(key, provider('old-secret'))).toEqual({ success: true })
    const configPath = join(fixture.root, 'config.json')
    const backupPath = join(fixture.root, 'config.backup.json')
    await rename(configPath, backupPath)
    await mkdir(configPath)
    expect(await setConfigValue(key, provider('new-secret'))).toMatchObject({ success: false })
    expect(fixture.vault.get('codex')).toContain('old-secret')
    expect(fixture.vault.get('codex')).not.toContain('new-secret')
    await rmdir(configPath)
    await rename(backupPath, configPath)
    expect(await getConfigValue(key)).toEqual(provider('old-secret'))
  })

  it('rejects a new secret when durable encryption is unavailable', async () => {
    fixture.persistent = false
    expect(await setConfigValue(key, provider('unavailable-secret'))).toEqual({
      success: false,
      error: 'Encrypted provider storage is unavailable'
    })
    expect(fixture.vault.size).toBe(0)
  })

  it('retains legacy plaintext until encrypted migration becomes available', async () => {
    fixture.persistent = false
    const input = provider('legacy-secret')
    await writeFile(join(fixture.root, 'config.json'), JSON.stringify({ [key]: input }))
    expect(await getConfigValue(key)).toEqual(input)
    expect(await readFile(join(fixture.root, 'config.json'), 'utf8')).toContain('legacy-secret')
    expect(fixture.vault.size).toBe(0)
    fixture.persistent = true
    expect(await getConfigValue(key)).toEqual(input)
    expect(await readFile(join(fixture.root, 'config.json'), 'utf8')).not.toContain('legacy-secret')
  })

  it('preserves the config root and rejects full-root writes when the vault cannot be read', async () => {
    expect(await setConfigValue(key, provider('saved-secret'))).toEqual({ success: true })
    const configPath = join(fixture.root, 'config.json')
    const before = await readFile(configPath, 'utf8')
    fixture.vaultReadFailure = true
    const raw = await readConfig()
    expect(raw[key]).toBeDefined()
    await expect(getConfigValue(key)).rejects.toThrow('vault is unavailable')
    await expect(writeConfig({ ...raw, unrelated: 'new' })).rejects.toThrow(
      'simulated vault read failure'
    )
    expect(await setConfigValue(key, { state: { providers: [] }, version: 1 })).toMatchObject({
      success: false,
      error: 'simulated vault read failure'
    })
    expect(await readFile(configPath, 'utf8')).toBe(before)
    await writeConfig({ unrelated: 'new' })
    const unrelatedWrite = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    expect(unrelatedWrite[key]).toEqual(JSON.parse(before)[key])
    expect(unrelatedWrite.unrelated).toBe('new')
  })
})
