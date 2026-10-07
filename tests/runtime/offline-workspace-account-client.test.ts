import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const electronState = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) =>
      name === 'sessionData'
        ? path.join(electronState.userData, 'session-data')
        : electronState.userData,
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  shell: { openExternal: async () => undefined }
}))

let userData: string

beforeAll(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'ola-offline-workspaces-'))
  electronState.userData = userData
  await mkdir(path.join(userData, 'session-data'))
  await writeFile(
    path.join(userData, 'session-data', 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: 'test-key' } })
  )
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await rm(userData, { recursive: true, force: true })
})

describe('main account-bound offline workspace directory', () => {
  it('uses cached local metadata only for transport failures and clears it on logout', async () => {
    let accountClient = await import('../../src/main/remote/account-client')
    const base = 'https://account.example.test'
    let mode: 'online' | 'offline' | 'denied' | 'forbidden' = 'online'
    vi.stubGlobal('fetch', async (url: string) => {
      if (mode === 'offline') throw new TypeError('network unavailable')
      if (mode === 'denied')
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      if (mode === 'forbidden')
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
      if (url.endsWith('/api/auth/login'))
        return Response.json({ token: 'test-token', account: { id: 'account-a' } })
      if (url.endsWith('/api/account/workspaces'))
        return Response.json({
          workspaces: [{ id: 'team-a', kind: 'team', name: 'Team A' }]
        })
      return Response.json({ success: true })
    })

    await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'login',
      payload: { email: 'a@example.test', password: 'secret' }
    })
    expect(await accountClient.loadManagedWorkspaceIds()).toEqual(new Set(['team-a']))

    vi.resetModules()
    accountClient = await import('../../src/main/remote/account-client')
    const { onWorkspaceDirectoryChanged } = await import('../../src/main/remote/account-lifecycle')
    const directories: string[][] = []
    const unsubscribe = onWorkspaceDirectoryChanged((ids) => {
      directories.push([...ids])
    })
    mode = 'offline'
    expect(await accountClient.loadOfflineWorkspaceIds()).toEqual(new Set(['team-a']))
    await expect(accountClient.loadManagedWorkspaceIds()).rejects.toThrow('network unavailable')
    expect(
      await accountClient.invokeRemoteAccount({ apiBaseUrl: base, operation: 'hydrate' })
    ).toMatchObject({ account: { id: 'account-a' }, offline: true })

    mode = 'denied'
    await expect(accountClient.loadOfflineWorkspaceIds()).rejects.toThrow('Unauthorized')
    expect(directories.at(-1)).toEqual([])
    expect(await accountClient.loadOfflineWorkspaceExpiresAt()).toBeNull()
    await expect(
      accountClient.invokeRemoteAccount({ apiBaseUrl: base, operation: 'hydrate' })
    ).rejects.toThrow('Unauthorized')

    mode = 'forbidden'
    await expect(accountClient.loadOfflineWorkspaceIds()).rejects.toThrow('Forbidden')
    expect(directories.at(-1)).toEqual([])

    mode = 'offline'
    await expect(accountClient.loadOfflineWorkspaceIds()).rejects.toThrow('network unavailable')

    await accountClient.invokeRemoteAccount({ apiBaseUrl: base, operation: 'logout' })
    expect(await accountClient.loadOfflineWorkspaceIds()).toEqual(new Set())
    unsubscribe()
  })
})
