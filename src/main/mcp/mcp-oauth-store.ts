import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import type {
  OAuthClientInformationMixed,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { waitForSafeStorageKeyPersistence } from '../credentials/safe-storage-key-persistence'
import { olaDataRoot } from '../lib/ola-data-root'

/**
 * Per-server OAuth state for MCP servers. Everything the SDK's authorization flow
 * needs to survive a restart lives here, and only Main ever reads it back.
 */
export interface McpOAuthCredentials {
  /**
   * Loopback redirect used for the pending (or last) authorization. It is pinned
   * before discovery starts, so a restart can reuse the same registered client.
   */
  redirectUri?: string
  /** Pending CSRF state; validated before any authorization code is exchanged. */
  state?: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  /** Absolute expiry derived from `expires_in`, so refresh decisions need no clock math at read time. */
  expiresAt?: number
  codeVerifier?: string
}

export type McpOAuthCredentialScope = 'all' | 'client' | 'tokens' | 'verifier'

type CredentialRoot = Record<string, McpOAuthCredentials>

export interface McpOAuthCryptography {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
  readyForCommit?(): Promise<void>
}

function getSafeStorageCryptography(): McpOAuthCryptography {
  return {
    available: () => {
      try {
        const backend = (
          safeStorage as typeof safeStorage & { getSelectedStorageBackend?: () => string }
        ).getSelectedStorageBackend?.()
        return safeStorage.isEncryptionAvailable() && backend !== 'basic_text'
      } catch {
        return false
      }
    },
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
    readyForCommit: waitForSafeStorageKeyPersistence
  }
}

function parseRoot(value: string): CredentialRoot {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid MCP OAuth credential store')
  }
  const root: CredentialRoot = {}
  for (const [serverId, credentials] of Object.entries(parsed as Record<string, unknown>)) {
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      throw new Error('Invalid MCP OAuth credential store')
    }
    root[serverId] = credentials as McpOAuthCredentials
  }
  return root
}

function defaultStorePath(): string {
  return join(olaDataRoot(), 'mcp-oauth.bin')
}

let sharedStore: McpOAuthCredentialStore | undefined

/**
 * One store per process. Two instances would each keep their own cached snapshot
 * and the last writer would silently drop the other's credentials.
 */
export function getMcpOAuthCredentialStore(): McpOAuthCredentialStore {
  sharedStore ??= new McpOAuthCredentialStore()
  return sharedStore
}

/**
 * Encrypted-at-rest store for MCP OAuth credentials. When the platform keychain is
 * unavailable the values stay in memory only: a token that cannot be encrypted must
 * never be written to disk in plaintext.
 */
export class McpOAuthCredentialStore {
  private tail: Promise<void> = Promise.resolve()
  private memory: CredentialRoot | undefined

  constructor(
    private readonly path: string = defaultStorePath(),
    private readonly cryptography: McpOAuthCryptography = getSafeStorageCryptography()
  ) {}

  isPersistent(): boolean {
    return this.cryptography.available()
  }

  async read(serverId: string): Promise<McpOAuthCredentials> {
    const root = await this.readRoot()
    return { ...(root[serverId] ?? {}) }
  }

  async list(): Promise<Record<string, McpOAuthCredentials>> {
    return structuredClone(await this.readRoot())
  }

  patch(serverId: string, change: Partial<McpOAuthCredentials>): Promise<void> {
    return this.mutate((root) => {
      const next: McpOAuthCredentials = { ...(root[serverId] ?? {}) }
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined) delete next[key as keyof McpOAuthCredentials]
        else (next as Record<string, unknown>)[key] = value
      }
      if (Object.keys(next).length === 0) delete root[serverId]
      else root[serverId] = next
    })
  }

  clear(serverId: string, scope: McpOAuthCredentialScope = 'all'): Promise<void> {
    return this.mutate((root) => {
      const current = root[serverId]
      if (!current) return
      if (scope === 'all') {
        delete root[serverId]
        return
      }
      if (scope === 'client') delete current.clientInformation
      if (scope === 'tokens') {
        delete current.tokens
        delete current.expiresAt
      }
      if (scope === 'verifier') delete current.codeVerifier
      if (Object.keys(current).length === 0) delete root[serverId]
    })
  }

  /** Drops a server's credentials, keeping loopback registrations for other servers intact. */
  forget(serverIds: readonly string[]): Promise<void> {
    return this.mutate((root) => {
      for (const serverId of serverIds) delete root[serverId]
    })
  }

  private async readRoot(): Promise<CredentialRoot> {
    if (this.memory) return structuredClone(this.memory)
    if (!this.cryptography.available()) {
      // Startup may read before the platform key is unlocked; do not cache an
      // empty snapshot or every later read would hide the encrypted file.
      return {}
    }
    try {
      this.memory = parseRoot(this.cryptography.decrypt(await readFile(this.path)))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      this.memory = {}
    }
    return structuredClone(this.memory)
  }

  private mutate(change: (root: CredentialRoot) => void): Promise<void> {
    const result = this.tail.then(async () => {
      const root = await this.readRoot()
      change(root)
      if (!this.cryptography.available()) {
        this.memory = root
        return
      }
      const encrypted = this.cryptography.encrypt(JSON.stringify(root))
      await this.cryptography.readyForCommit?.()
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = join(dirname(this.path), '.' + randomUUID() + '.mcp-oauth.bin')
      await writeFile(temporary, encrypted, { mode: 0o600 })
      await rename(temporary, this.path)
      this.memory = root
    })
    this.tail = result.catch(() => undefined)
    return result
  }
}
