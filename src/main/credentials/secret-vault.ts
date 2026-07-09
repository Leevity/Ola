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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  CredentialRef,
  CredentialSource,
  VerificationResult,
  VaultStatus
} from '../../shared/credentials'

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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
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
    if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
      return parsed
    }
  } catch (error) {
    console.error('[SecretVault] failed to read index, starting fresh:', error)
  }
  return { version: 1, entries: [] }
}

function writeIndex(index: CredentialIndex): void {
  writeFileSync(getIndexPath(), JSON.stringify(index, null, 2), 'utf8')
}

// In-memory decrypted cache. Loaded lazily on first access.
// We never persist plaintext to disk.
let plaintextCache: Map<string, string> | null = null

function getPlaintextCache(): Map<string, string> {
  if (plaintextCache) return plaintextCache
  plaintextCache = new Map<string, string>()
  // Try to hydrate from the encrypted vault file.
  const path = getVaultPath()
  if (!existsSync(path)) return plaintextCache
  try {
    const buf = readFileSync(path)
    if (buf.length === 0) return plaintextCache
    if (isSafeStorageAvailable()) {
      const json = safeStorage.decryptString(buf)
      const entries = JSON.parse(json) as Record<string, string>
      for (const [k, v] of Object.entries(entries)) {
        plaintextCache.set(k, v)
      }
    } else {
      // No safeStorage: keep empty cache. Credentials cannot be read.
      console.warn('[SecretVault] safeStorage unavailable; vault not hydrated')
    }
  } catch (error) {
    console.error('[SecretVault] failed to decrypt vault:', error)
  }
  return plaintextCache
}

function persistPlaintextCache(): void {
  if (!isSafeStorageAvailable()) {
    // Without safeStorage, we don't persist plaintext. Vault is session-only.
    return
  }
  const obj: Record<string, string> = {}
  for (const [k, v] of getPlaintextCache().entries()) obj[k] = v
  const json = JSON.stringify(obj)
  const encrypted = safeStorage.encryptString(json)
  writeFileSync(getVaultPath(), encrypted)
}

export function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function getVaultStatus(): VaultStatus {
  if (isSafeStorageAvailable()) {
    return { available: true, backend: 'safe_storage' }
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

export function storeCredential(input: StoreCredentialInput): CredentialRef {
  const id = randomUUID()
  const createdAt = Date.now()
  const vaultKey = randomUUID()

  // Encrypt and stash the password.
  if (isSafeStorageAvailable()) {
    const encrypted = safeStorage.encryptString(input.password)
    getPlaintextCache().set(vaultKey, input.password)
    // Persist the cache to disk (encrypted form).
    persistPlaintextCache()
    // Discard the in-memory encrypted form to keep the index clean.
    void encrypted
  } else {
    // No safeStorage: still keep in memory only.
    getPlaintextCache().set(vaultKey, input.password)
  }

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
  const index = readIndex()
  index.entries.push(entry)
  writeIndex(index)

  return toCredentialRef(entry, index)
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

export function deleteCredential(id: string): boolean {
  const index = readIndex()
  const before = index.entries.length
  const removed = index.entries.filter((e) => e.id === id)
  index.entries = index.entries.filter((e) => e.id !== id)
  if (index.entries.length === before) return false
  writeIndex(index)
  // Also wipe from the encrypted cache.
  for (const e of removed) {
    getPlaintextCache().delete(e.vaultKey)
  }
  persistPlaintextCache()
  return true
}

export function updateCredential(
  id: string,
  input: { username?: string; password?: string; notes?: string }
): CredentialRef | null {
  const index = readIndex()
  const entry = index.entries.find((e) => e.id === id)
  if (!entry) return null
  if (input.username !== undefined) entry.username = input.username
  if (input.notes !== undefined) entry.notes = input.notes
  if (input.password !== undefined) {
    // Re-encrypt the new password into the vault cache.
    getPlaintextCache().set(entry.vaultKey, input.password)
    persistPlaintextCache()
  }
  entry.lastUsedAt = Date.now()
  writeIndex(index)
  // Return a ref (no plaintext).
  const { vaultKey: _, ...ref } = entry
  return ref as CredentialRef
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
  getPlaintextCache()
  // If the app was started before safeStorage was ready, retry on app ready.
  if (!isSafeStorageAvailable() && app.isReady()) {
    console.warn('[SecretVault] safeStorage is not available; credentials will be session-only.')
  }
}
