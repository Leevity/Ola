// SecretVault: password storage backed by Electron safeStorage.
// safeStorage uses:
//   - macOS: Keychain Services (when available)
//   - Windows: DPAPI
//   - Linux: libsecret (gnome-keyring/kwallet) when available, otherwise an
//            in-memory encryption fallback (NOT persisted on disk without a keyring)
//
// This module runs in the main process. Plaintext passwords never leave the
// main process except for direct injection into the webview via webContents.

import { app, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  CredentialRef,
  CredentialSource,
  VerificationResult,
  VaultStatus
} from '../../shared/credentials'
import { waitForSafeStorageKeyPersistence } from './safe-storage-key-persistence'

interface StoredCredential {
  id: string
  domain: string
  username: string
  kind: 'password'
  source: CredentialSource
  builtinTemplateId?: string
  projectId?: string
  notes?: string
  createdAt: number
  lastUsedAt?: number
  lastVerifiedAt?: number
  lastVerificationStatus?: 'pass' | 'challenge' | 'fail' | 'unknown'
  // Encrypted password (base64 of safeStorage.encryptString output).
  passwordEncrypted: string
}

interface CredentialIndex {
  version: 1
  entries: Array<Omit<StoredCredential, 'passwordEncrypted'> & { vaultKey: string }>
}

const CREDENTIALS_DIR_NAME = 'credentials'
const INDEX_FILE = 'index.json'
const VAULT_FILE = 'vault.bin'

function getCredentialsDir(): string {
  // Reuse Electron's userData directory so credentials live alongside the
  // rest of Ola's data. They are never synced via WebDAV (see plan §4.2).
  // app.getPath requires the app to be ready; if we are somehow called
  // before that, fall back to a stable temp directory so the rest of the
  // module can still be loaded.
  const base = app.isReady() ? app.getPath('userData') : tmpdir()
  const dir = join(base, CREDENTIALS_DIR_NAME)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Existing installations may have created this directory under a permissive
  // umask. Credential metadata is sensitive too, so repair its mode whenever
  // the vault is accessed.
  try {
    chmodSync(dir, 0o700)
  } catch {
    // The encrypted files remain mode 0600; callers still receive a useful
    // vault error if the platform refuses the directory operation.
  }
  return dir
}

function getIndexPath(): string {
  return join(getCredentialsDir(), INDEX_FILE)
}

function getVaultPath(): string {
  return join(getCredentialsDir(), VAULT_FILE)
}

function readIndex(): CredentialIndex {
  const path = getIndexPath()
  if (!existsSync(path)) return { version: 1, entries: [] }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as CredentialIndex
    if (
      parsed &&
      parsed.version === 1 &&
      Array.isArray(parsed.entries) &&
      parsed.entries.every(
        (entry) =>
          entry &&
          typeof entry.id === 'string' &&
          typeof entry.domain === 'string' &&
          typeof entry.vaultKey === 'string'
      )
    ) {
      return parsed
    }
    throw new Error('Invalid credential index')
  } catch (error) {
    console.error('[SecretVault] failed to read index:', error)
    throw error
  }
}

function writeIndex(index: CredentialIndex): void {
  writeAtomic(getIndexPath(), Buffer.from(JSON.stringify(index, null, 2), 'utf8'))
}

function writeAtomic(target: string, contents: Buffer): void {
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { mode: 0o600 })
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may not have been created.
    }
    throw error
  }
}

// In-memory decrypted cache. Loaded lazily on first access.
// We never persist plaintext to disk.
let plaintextCache: Map<string, string> | null = null
let credentialMutationTail: Promise<void> = Promise.resolve()

function serializeCredentialMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = credentialMutationTail.then(operation)
  credentialMutationTail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function getPlaintextCache(): Map<string, string> {
  if (plaintextCache) return plaintextCache
  const loaded = new Map<string, string>()
  // Try to hydrate from the encrypted vault file.
  const path = getVaultPath()
  if (!existsSync(path)) {
    plaintextCache = loaded
    return loaded
  }
  try {
    const buf = readFileSync(path)
    if (buf.length === 0) throw new Error('Credential vault is empty')
    if (!isSafeStorageAvailable()) {
      throw new Error('Encrypted credential vault is unavailable')
    }
    const entries: unknown = JSON.parse(safeStorage.decryptString(buf))
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new Error('Invalid credential vault')
    }
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value !== 'string') throw new Error('Invalid credential vault')
      loaded.set(key, value)
    }
    plaintextCache = loaded
    return loaded
  } catch (error) {
    console.error('[SecretVault] failed to decrypt vault:', error)
    throw error
  }
}

async function persistPlaintextCache(values: Map<string, string>): Promise<void> {
  if (!isSafeStorageAvailable()) {
    // Without safeStorage, we don't persist plaintext. Vault is session-only.
    return
  }
  const obj: Record<string, string> = {}
  for (const [k, v] of values.entries()) obj[k] = v
  const json = JSON.stringify(obj)
  const encrypted = safeStorage.encryptString(json)
  await waitForSafeStorageKeyPersistence()
  writeAtomic(getVaultPath(), encrypted)
}

export function isSafeStorageAvailable(): boolean {
  try {
    const backend = (
      safeStorage as typeof safeStorage & {
        getSelectedStorageBackend?: () => string
      }
    ).getSelectedStorageBackend?.()
    // Electron's Linux basic_text backend provides obfuscation, not encryption.
    return safeStorage.isEncryptionAvailable() && backend !== 'basic_text'
  } catch {
    return false
  }
}

export function getVaultStatus(): VaultStatus {
  if (isSafeStorageAvailable()) {
    return { available: true, backend: 'safe_storage' }
  }
  if (existsSync(getVaultPath())) {
    return {
      available: false,
      backend: 'in_memory_fallback',
      reason:
        'Existing encrypted credentials cannot be opened until system secure storage is available.'
    }
  }
  return {
    available: true,
    backend: 'in_memory_fallback',
    reason:
      'System secure storage is unavailable. Credentials will be kept in memory only and lost when Ola restarts.'
  }
}

export interface StoreCredentialInput {
  domain: string
  username: string
  password: string
  source: CredentialSource
  builtinTemplateId?: string
  projectId?: string
  notes?: string
}

export function storeCredential(input: StoreCredentialInput): Promise<CredentialRef> {
  return serializeCredentialMutation(async () => {
    const id = randomUUID()
    const createdAt = Date.now()
    const vaultKey = randomUUID()
    const index = readIndex()

    const nextCache = new Map(getPlaintextCache())
    nextCache.set(vaultKey, input.password)
    await persistPlaintextCache(nextCache)

    const entry: Omit<StoredCredential, 'passwordEncrypted'> & { vaultKey: string } = {
      id,
      domain: input.domain,
      username: input.username,
      kind: 'password',
      source: input.source,
      builtinTemplateId: input.builtinTemplateId,
      projectId: input.projectId,
      notes: input.notes,
      createdAt,
      vaultKey
    }
    index.entries.push(entry)
    writeIndex(index)
    plaintextCache = nextCache

    return toCredentialRef(entry, index)
  })
}

function toCredentialRef(
  entry: Omit<StoredCredential, 'passwordEncrypted'> & { vaultKey: string },
  _index: CredentialIndex
): CredentialRef {
  return {
    id: entry.id,
    domain: entry.domain,
    usernameHint: entry.username,
    kind: entry.kind,
    source: entry.source,
    builtinTemplateId: entry.builtinTemplateId,
    projectId: entry.projectId,
    lastUsedAt: entry.lastUsedAt,
    lastVerifiedAt: entry.lastVerifiedAt,
    lastVerificationStatus: entry.lastVerificationStatus,
    createdAt: entry.createdAt
  }
}

export function listCredentials(filter?: { domain?: string; projectId?: string }): CredentialRef[] {
  const index = readIndex()
  return index.entries
    .filter((entry) => {
      if (filter?.domain && entry.domain !== filter.domain) return false
      if (filter?.projectId && entry.projectId !== filter.projectId) return false
      return true
    })
    .map((entry) => toCredentialRef(entry, index))
}

export function getCredentialRef(id: string): CredentialRef | null {
  const index = readIndex()
  const entry = index.entries.find((item) => item.id === id)
  return entry ? toCredentialRef(entry, index) : null
}

export function deleteCredential(id: string): Promise<boolean> {
  return serializeCredentialMutation(async () => {
    const index = readIndex()
    const originalIndex: CredentialIndex = { ...index, entries: [...index.entries] }
    const before = index.entries.length
    const removed = index.entries.filter((e) => e.id === id)
    index.entries = index.entries.filter((e) => e.id !== id)
    if (index.entries.length === before) return false
    const nextCache = new Map(getPlaintextCache())
    for (const entry of removed) nextCache.delete(entry.vaultKey)
    writeIndex(index)
    try {
      await persistPlaintextCache(nextCache)
      plaintextCache = nextCache
    } catch (error) {
      writeIndex(originalIndex)
      throw error
    }
    return true
  })
}

export function updateCredential(
  id: string,
  input: { username?: string; password?: string; notes?: string }
): Promise<CredentialRef | null> {
  return serializeCredentialMutation(async () => {
    const index = readIndex()
    const entry = index.entries.find((e) => e.id === id)
    if (!entry) return null
    if (input.username !== undefined) entry.username = input.username
    if (input.notes !== undefined) entry.notes = input.notes
    if (input.password !== undefined) {
      const nextCache = new Map(getPlaintextCache())
      nextCache.set(entry.vaultKey, input.password)
      await persistPlaintextCache(nextCache)
      plaintextCache = nextCache
    }
    entry.lastUsedAt = Date.now()
    writeIndex(index)
    // Return a ref (no plaintext).
    const { vaultKey: _, ...ref } = entry
    return ref as CredentialRef
  })
}

export function updateVerificationResult(
  id: string,
  result: VerificationResult
): CredentialRef | null {
  const index = readIndex()
  const entry = index.entries.find((e) => e.id === id)
  if (!entry) return null
  entry.lastVerifiedAt = result.testedAt
  entry.lastVerificationStatus = result.status
  writeIndex(index)
  return toCredentialRef(entry, index)
}

/**
 * Get the plaintext password. Used ONLY by the verification flow that runs
 * inside the main process (which then injects it into the webview via
 * webContents.executeJavaScript). Renderer must never call this.
 */
export function getPlaintextPassword(id: string): string | null {
  const index = readIndex()
  const entry = index.entries.find((e) => e.id === id)
  if (!entry) return null
  return getPlaintextCache().get(entry.vaultKey) ?? null
}

export function getCredentialEntryForInjection(
  id: string
): { domain: string; username: string; password: string } | null {
  const index = readIndex()
  const entry = index.entries.find((e) => e.id === id)
  if (!entry) return null
  const password = getPlaintextCache().get(entry.vaultKey) ?? null
  if (!password) return null
  return { domain: entry.domain, username: entry.username, password }
}

export function touchCredential(id: string): void {
  const index = readIndex()
  const entry = index.entries.find((e) => e.id === id)
  if (!entry) return
  entry.lastUsedAt = Date.now()
  writeIndex(index)
}

// Initialize once on app startup.
export function initSecretVault(): void {
  // Touch the directory so it exists, and warm the cache.
  getCredentialsDir()
  try {
    getPlaintextCache()
  } catch {
    // Keep handlers available; every credential read or write still fails closed.
  }
  // If the app was started before safeStorage was ready, retry on app ready.
  if (!isSafeStorageAvailable() && app.isReady()) {
    console.warn('[SecretVault] safeStorage is not available; credentials will be session-only.')
  }
}
