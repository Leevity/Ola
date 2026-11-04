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

/** A deletion made while the keychain is locked, replayed when the store can persist again. */
type MemoryOnlyIntent = {
  serverId: string
  /** Whole record removed (`forget`, `clear('all')`). */
  remove?: boolean
  /** Individual fields removed — a merge must not bring them back from disk. */
  cleared?: readonly (keyof McpOAuthCredentials)[]
}

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

/**
 * Recombine a disk snapshot with the writes that were accepted while the keychain was locked.
 * The merge is per field: a locked-keychain write usually touches one field (`state`,
 * `codeVerifier`) and must not replace the tokens or client registration that only exist on
 * disk. Deletions performed during that window are replayed from the tombstones, otherwise a
 * logout could be undone by the merge.
 */
function mergeMemoryOnlyWrites(
  disk: CredentialRoot,
  memory: CredentialRoot | undefined,
  removed: ReadonlySet<string>,
  cleared: ReadonlyMap<string, ReadonlySet<keyof McpOAuthCredentials>>
): CredentialRoot {
  const merged: CredentialRoot = { ...disk }
  for (const serverId of removed) delete merged[serverId]
  for (const [serverId, entry] of Object.entries(memory ?? {})) {
    const next: McpOAuthCredentials = { ...(merged[serverId] ?? {}), ...entry }
    for (const field of cleared.get(serverId) ?? []) {
      if (!(field in entry)) delete next[field]
    }
    merged[serverId] = next
  }
  return merged
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
  /** True while `memory` holds writes that could not be encrypted to disk yet. */
  private memoryOnly = false
  /** Server ids whose whole record was deleted while the keychain was unavailable. */
  private readonly memoryOnlyRemoved = new Set<string>()
  /** Per-server fields deleted while the keychain was unavailable, so a merge cannot revive them. */
  private readonly memoryOnlyClearedFields = new Map<string, Set<keyof McpOAuthCredentials>>()

  constructor(
    private readonly path: string = defaultStorePath(),
    private readonly cryptography: McpOAuthCryptography = getSafeStorageCryptography()
  ) {}

  isPersistent(): boolean {
    return this.cryptography.available()
  }

  async read(serverId: string): Promise<McpOAuthCredentials> {
    await this.flushMemoryOnlyWrites()
    const root = await this.readRoot()
    return { ...(root[serverId] ?? {}) }
  }

  async list(): Promise<Record<string, McpOAuthCredentials>> {
    await this.flushMemoryOnlyWrites()
    return structuredClone(await this.readRoot())
  }

  /**
   * Persist writes accepted while the keychain was locked. It runs as a normal mutation so the
   * commit is ordered by the queue; persisting straight from a read could interleave with a
   * concurrent mutation and overwrite it with the older snapshot.
   */
  private async flushMemoryOnlyWrites(): Promise<void> {
    if (!this.memoryOnly || !this.cryptography.available()) return
    await this.mutate(() => undefined).catch(() => undefined)
  }

  patch(serverId: string, change: Partial<McpOAuthCredentials>): Promise<void> {
    // While the keychain is locked the in-memory snapshot may not even know this server exists,
    // so an explicit field deletion has to be recorded as intent — a before/after diff would see
    // nothing to remove.
    const cleared = Object.entries(change)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key as keyof McpOAuthCredentials)
    return this.mutate(
      (root) => {
        const next: McpOAuthCredentials = { ...(root[serverId] ?? {}) }
        for (const [key, value] of Object.entries(change)) {
          if (value === undefined) delete next[key as keyof McpOAuthCredentials]
          else (next as Record<string, unknown>)[key] = value
        }
        if (Object.keys(next).length === 0) delete root[serverId]
        else root[serverId] = next
      },
      [{ serverId, cleared }]
    )
  }

  clear(serverId: string, scope: McpOAuthCredentialScope = 'all'): Promise<void> {
    const intent: MemoryOnlyIntent =
      scope === 'all'
        ? { serverId, remove: true }
        : {
            serverId,
            cleared:
              scope === 'client'
                ? ['clientInformation']
                : scope === 'tokens'
                  ? ['tokens', 'expiresAt']
                  : ['codeVerifier']
          }
    return this.mutate(
      (root) => {
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
      },
      [intent]
    )
  }

  /** Drops a server's credentials, keeping loopback registrations for other servers intact. */
  forget(serverIds: readonly string[]): Promise<void> {
    return this.mutate(
      (root) => {
        for (const serverId of serverIds) delete root[serverId]
      },
      serverIds.map((serverId) => ({ serverId, remove: true }))
    )
  }

  private async readRoot(): Promise<CredentialRoot> {
    if (!this.cryptography.available()) {
      // Startup may read before the platform key is unlocked. Never cache an empty
      // snapshot as if it were the merged state, or a later unlocked keychain
      // would hide the encrypted file.
      return this.memory ? structuredClone(this.memory) : {}
    }
    if (this.memory && !this.memoryOnly) return structuredClone(this.memory)
    // The keychain just became available (or this is the first read). Load the
    // encrypted file so credentials for other servers stay visible, then overlay
    // the in-memory writes made while it was locked.
    let disk: CredentialRoot = {}
    try {
      disk = parseRoot(this.cryptography.decrypt(await readFile(this.path)))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    this.memory = mergeMemoryOnlyWrites(
      disk,
      this.memory,
      this.memoryOnlyRemoved,
      this.memoryOnlyClearedFields
    )
    this.memoryOnly = false
    // Callers that commit (mutate) persist the merged snapshot themselves; the read path flushes
    // through the queue first, so no write is issued from here.
    this.memoryOnlyRemoved.clear()
    this.memoryOnlyClearedFields.clear()
    return structuredClone(this.memory)
  }

  private async persist(root: CredentialRoot): Promise<void> {
    const encrypted = this.cryptography.encrypt(JSON.stringify(root))
    await this.cryptography.readyForCommit?.()
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = join(dirname(this.path), '.' + randomUUID() + '.mcp-oauth.bin')
    await writeFile(temporary, encrypted, { mode: 0o600 })
    await rename(temporary, this.path)
  }

  private mutate(
    change: (root: CredentialRoot) => void,
    intents: readonly MemoryOnlyIntent[] = []
  ): Promise<void> {
    const result = this.tail.then(async () => {
      const root = await this.readRoot()
      // Snapshot only when the write cannot be persisted: the diff is what lets a later merge
      // tell "this field was cleared" apart from "this field was never known here".
      const before = this.cryptography.available() ? null : structuredClone(root)
      change(root)
      if (!this.cryptography.available()) {
        if (before) this.recordMemoryOnlyRemovals(before, root)
        // Explicit intent covers the case the diff cannot see: the locked window never loaded
        // this server, so deleting its tokens looks like a no-op.
        for (const intent of intents) this.recordIntent(intent)
        this.memory = root
        this.memoryOnly = true
        return
      }
      await this.persist(root)
      this.memory = root
      this.memoryOnly = false
      this.memoryOnlyRemoved.clear()
      this.memoryOnlyClearedFields.clear()
    })
    this.tail = result.catch(() => undefined)
    return result
  }

  private recordIntent(intent: MemoryOnlyIntent): void {
    if (intent.remove) {
      this.memoryOnlyRemoved.add(intent.serverId)
      this.memoryOnlyClearedFields.delete(intent.serverId)
      return
    }
    if (!intent.cleared?.length) return
    const existing = this.memoryOnlyClearedFields.get(intent.serverId) ?? new Set()
    for (const field of intent.cleared) existing.add(field)
    this.memoryOnlyClearedFields.set(intent.serverId, existing)
  }

  /** Record deletions made while the keychain was unavailable so a merge cannot undo them. */
  private recordMemoryOnlyRemovals(before: CredentialRoot, after: CredentialRoot): void {
    for (const serverId of Object.keys(before)) {
      if (serverId in after) continue
      this.memoryOnlyRemoved.add(serverId)
      this.memoryOnlyClearedFields.delete(serverId)
    }
    for (const [serverId, previous] of Object.entries(before)) {
      const next = after[serverId]
      if (!next) continue
      const fields = new Set<keyof McpOAuthCredentials>()
      for (const field of Object.keys(previous) as (keyof McpOAuthCredentials)[]) {
        if (!(field in next)) fields.add(field)
      }
      if (!fields.size) continue
      const existing = this.memoryOnlyClearedFields.get(serverId) ?? new Set()
      for (const field of fields) existing.add(field)
      this.memoryOnlyClearedFields.set(serverId, existing)
    }
  }
}
