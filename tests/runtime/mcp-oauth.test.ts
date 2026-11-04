import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fixture = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^enc:/, ''),
    getSelectedStorageBackend: () => 'dpapi'
  }
}))
vi.mock('../../src/main/credentials/safe-storage-key-persistence', () => ({
  waitForSafeStorageKeyPersistence: async () => undefined
}))
vi.mock('../../src/main/lib/ola-data-root', () => ({ olaDataRoot: () => fixture.root }))

import type {
  OAuthClientInformationMixed,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  McpOAuthCredentialStore,
  type McpOAuthCredentials,
  type McpOAuthCryptography
} from '../../src/main/mcp/mcp-oauth-store'
import { McpOAuthProvider, serverScopedBackend } from '../../src/main/mcp/mcp-oauth-provider'
import {
  closeAllMcpOAuthLoopbacks,
  getMcpOAuthLoopback,
  MCP_OAUTH_CALLBACK_PATH,
  startMcpOAuthLoopback
} from '../../src/main/mcp/mcp-oauth-loopback'

const redirect = 'http://localhost:43117/mcp/oauth/callback'

function memoryBackend(initial: McpOAuthCredentials = {}) {
  let state: McpOAuthCredentials = { ...initial }
  return {
    read: async () => ({ ...state }),
    patch: async (change: Partial<McpOAuthCredentials>) => {
      const next: McpOAuthCredentials = { ...state }
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined) delete next[key as keyof McpOAuthCredentials]
        else (next as Record<string, unknown>)[key] = value
      }
      state = next
    },
    clear: async () => {
      state = {}
    },
    snapshot: () => ({ ...state })
  }
}

function provider(backend: ReturnType<typeof memoryBackend>, extra: { clientId?: string } = {}) {
  const urls: string[] = []
  const instance = new McpOAuthProvider({
    redirectUri: redirect,
    clientName: 'Ola Test',
    backend,
    ...extra,
    onAuthorizationUrl: (url) => {
      urls.push(url.toString())
    }
  })
  return { instance, urls }
}

const tokens: OAuthTokens = {
  access_token: 'access-1',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'refresh-1'
}

describe('McpOAuthProvider', () => {
  it('advertises a public client that uses PKCE instead of a secret', () => {
    const backend = memoryBackend()
    const { instance } = provider(backend)
    const metadata = instance.clientMetadata
    expect(metadata.redirect_uris).toEqual([redirect])
    expect(metadata.token_endpoint_auth_method).toBe('none')
    expect(metadata.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(metadata.response_types).toEqual(['code'])
    expect(metadata).not.toHaveProperty('client_secret')
  })

  it('reuses one CSRF state and one code verifier across calls', async () => {
    const backend = memoryBackend()
    const { instance } = provider(backend)

    expect(await instance.state()).toBe(await instance.state())
    await instance.saveCodeVerifier('verifier-1')
    expect(await instance.codeVerifier()).toBe('verifier-1')
    expect(backend.snapshot().state).toBe(await instance.state())
  })

  it('refuses to answer a code verifier request before one was saved', async () => {
    const { instance } = provider(memoryBackend())
    await expect(instance.codeVerifier()).rejects.toThrow('No PKCE code verifier')
  })

  it('records the authorization URL instead of navigating a browser', async () => {
    const backend = memoryBackend()
    const { instance, urls } = provider(backend)

    expect(instance.pendingAuthorizationUrl).toBeUndefined()
    await instance.redirectToAuthorization(new URL('https://auth.example.com/authorize?x=1'))
    expect(urls).toEqual(['https://auth.example.com/authorize?x=1'])
    expect(instance.pendingAuthorizationUrl?.toString()).toBe(
      'https://auth.example.com/authorize?x=1'
    )

    await instance.invalidateCredentials('tokens')
    expect(instance.pendingAuthorizationUrl).toBeUndefined()
  })

  it('derives an absolute expiry from expires_in', async () => {
    const backend = memoryBackend()
    const { instance } = provider(backend)
    const before = Date.now()

    await instance.saveTokens(tokens)

    const stored = backend.snapshot()
    expect(stored.tokens?.access_token).toBe('access-1')
    expect(stored.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(stored.expiresAt).toBeLessThanOrEqual(before + 3_600_000 + 5_000)
  })

  it('leaves the expiry unset when the server does not send expires_in', async () => {
    const backend = memoryBackend()
    const { instance } = provider(backend)
    await instance.saveTokens({ access_token: 'access-2', token_type: 'Bearer' })
    expect(backend.snapshot().expiresAt).toBeUndefined()
  })

  it('falls back to a configured pre-registered client id', async () => {
    const backend = memoryBackend()
    const stored: OAuthClientInformationMixed = { client_id: 'dynamic-client' }

    expect(
      await provider(backend, { clientId: 'pinned-client' }).instance.clientInformation()
    ).toEqual({ client_id: 'pinned-client' })

    await provider(backend).instance.saveClientInformation(stored)
    expect(
      await provider(backend, { clientId: 'pinned-client' }).instance.clientInformation()
    ).toEqual(stored)
  })

  it('has no client information when neither a registration nor an id exists', async () => {
    expect(await provider(memoryBackend()).instance.clientInformation()).toBeUndefined()
  })

  it('scopes every backend call to one server', async () => {
    // `fixture.root` is only populated by the credential-store suite below, so this test
    // owns its own directory to avoid writing a credential file next to the repository.
    const root = await mkdtemp(join(tmpdir(), 'ola-mcp-oauth-scope-'))
    const store = new McpOAuthCredentialStore(join(root, 'mcp-oauth.bin'), memoryCryptography())
    const a = new McpOAuthProvider({
      redirectUri: redirect,
      backend: serverScopedBackend(store, 'server-a')
    })
    const b = new McpOAuthProvider({
      redirectUri: redirect,
      backend: serverScopedBackend(store, 'server-b')
    })

    try {
      await a.saveTokens(tokens)
      await b.saveTokens({ access_token: 'access-b', token_type: 'Bearer' })

      expect((await store.read('server-a')).tokens?.access_token).toBe('access-1')
      expect((await store.read('server-b')).tokens?.access_token).toBe('access-b')

      await a.invalidateCredentials('tokens')
      expect((await store.read('server-a')).tokens).toBeUndefined()
      expect((await store.read('server-b')).tokens?.access_token).toBe('access-b')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function memoryCryptography(): McpOAuthCryptography {
  return {
    available: () => true,
    // Reversible and stateless, so a second store instance can read the same file.
    encrypt: (value) => Buffer.from(Buffer.from(value, 'utf8').map((byte) => byte ^ 0x5a)),
    decrypt: (value) => Buffer.from(value.map((byte) => byte ^ 0x5a)).toString('utf8')
  }
}

describe('McpOAuthCredentialStore', () => {
  let path = ''

  beforeEach(async () => {
    fixture.root = await mkdtemp(join(tmpdir(), 'ola-mcp-oauth-'))
    path = join(fixture.root, 'mcp-oauth.bin')
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('round-trips credentials through the encrypted file', async () => {
    const store = new McpOAuthCredentialStore(path, memoryCryptography())
    await store.patch('server-a', {
      redirectUri: redirect,
      state: 'state-1',
      codeVerifier: 'verifier-1',
      clientInformation: { client_id: 'client-1' },
      tokens,
      expiresAt: Date.now() + 1000
    })

    const reopened = new McpOAuthCredentialStore(path, memoryCryptography())
    const restored = await reopened.read('server-a')
    expect(restored.redirectUri).toBe(redirect)
    expect(restored.state).toBe('state-1')
    expect(restored.codeVerifier).toBe('verifier-1')
    expect(restored.clientInformation).toEqual({ client_id: 'client-1' })
    expect(restored.tokens?.refresh_token).toBe('refresh-1')
  })

  it('drops keys a patch sets to undefined instead of persisting them', async () => {
    const store = new McpOAuthCredentialStore(path, memoryCryptography())
    await store.patch('server-a', { state: 'state-1', codeVerifier: 'verifier-1' })
    await store.patch('server-a', { state: undefined, codeVerifier: undefined })

    // Nothing left means the server entry disappears entirely.
    expect(await store.read('server-a')).toEqual({})
    expect(await store.list()).toEqual({})
  })

  it('scopes clears to the requested credential kind', async () => {
    const store = new McpOAuthCredentialStore(path, memoryCryptography())
    await store.patch('server-a', {
      clientInformation: { client_id: 'client-1' },
      tokens,
      expiresAt: Date.now() + 1000,
      codeVerifier: 'verifier-1'
    })

    await store.clear('server-a', 'tokens')
    const afterTokens = await store.read('server-a')
    expect(afterTokens.tokens).toBeUndefined()
    expect(afterTokens.expiresAt).toBeUndefined()
    expect(afterTokens.clientInformation).toEqual({ client_id: 'client-1' })

    await store.clear('server-a', 'client')
    expect((await store.read('server-a')).clientInformation).toBeUndefined()
  })

  it('forgets removed servers and keeps the rest', async () => {
    const store = new McpOAuthCredentialStore(path, memoryCryptography())
    await store.patch('keep', { state: 'keep-state' })
    await store.patch('drop', { state: 'drop-state' })

    await store.forget(['drop'])

    const remaining = await store.list()
    expect(Object.keys(remaining)).toEqual(['keep'])
    expect(remaining.keep.state).toBe('keep-state')
  })

  it('keeps credentials in memory only when the platform key is unavailable', async () => {
    const cryptography: McpOAuthCryptography = {
      available: () => false,
      encrypt: () => {
        throw new Error('must not encrypt')
      },
      decrypt: () => {
        throw new Error('must not decrypt')
      }
    }
    const store = new McpOAuthCredentialStore(path, cryptography)
    await store.patch('server-a', { tokens })

    expect((await store.read('server-a')).tokens?.access_token).toBe('access-1')
    expect(store.isPersistent()).toBe(false)
    await expect(
      import('node:fs/promises').then(({ readFile }) => readFile(path))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent writes so neither loses the other', async () => {
    const store = new McpOAuthCredentialStore(path, memoryCryptography())
    await Promise.all([
      store.patch('server-a', { state: 'a' }),
      store.patch('server-b', { state: 'b' }),
      store.patch('server-c', { state: 'c' })
    ])

    const all = await store.list()
    expect(all['server-a'].state).toBe('a')
    expect(all['server-b'].state).toBe('b')
    expect(all['server-c'].state).toBe('c')
  })
})

describe('MCP OAuth loopback listener', () => {
  afterEach(() => {
    closeAllMcpOAuthLoopbacks()
  })

  it('hands the authorization code to Main and closes itself', async () => {
    const received: Array<{ code?: string; state?: string | null; error?: string }> = []
    const loopback = await startMcpOAuthLoopback({
      serverId: 'server-a',
      preferredPort: 0,
      onCallback: (result) => {
        received.push(result)
        return { accepted: true }
      }
    })

    const response = await fetch(`${loopback.redirectUri}?code=code-1&state=state-1`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Authorization completed')
    expect(received).toEqual([{ code: 'code-1', state: 'state-1', error: undefined }])
    expect(getMcpOAuthLoopback('server-a')).toBeUndefined()
    expect(loopback.redirectUri.endsWith(MCP_OAUTH_CALLBACK_PATH)).toBe(true)
  })

  it('rejects a callback with an HTTP 400 when Main refuses it', async () => {
    const loopback = await startMcpOAuthLoopback({
      serverId: 'server-b',
      preferredPort: 0,
      onCallback: () => ({ accepted: false, message: 'Authorization state mismatch' })
    })

    const response = await fetch(`${loopback.redirectUri}?code=code-1&state=wrong`)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Authorization state mismatch')
  })

  it('reports a throwing verdict as a rejection instead of crashing the listener', async () => {
    const loopback = await startMcpOAuthLoopback({
      serverId: 'server-c',
      preferredPort: 0,
      onCallback: () => {
        throw new Error('token exchange failed')
      }
    })

    const response = await fetch(`${loopback.redirectUri}?error=access_denied`)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('token exchange failed')
  })

  it('404s any path other than the registered callback', async () => {
    const loopback = await startMcpOAuthLoopback({
      serverId: 'server-d',
      preferredPort: 0,
      onCallback: () => ({ accepted: true })
    })

    const response = await fetch(`http://localhost:${loopback.port}/somewhere-else`)
    expect(response.status).toBe(404)
    // An off-path request must not consume the pending authorization.
    expect(getMcpOAuthLoopback('server-d')).toBeDefined()
  })

  it('reuses the listener when authorization is started twice', async () => {
    const first = await startMcpOAuthLoopback({
      serverId: 'server-e',
      preferredPort: 0,
      onCallback: () => ({ accepted: true })
    })
    const second = await startMcpOAuthLoopback({
      serverId: 'server-e',
      preferredPort: 0,
      onCallback: () => ({ accepted: true })
    })

    expect(second.redirectUri).toBe(first.redirectUri)
  })
})
