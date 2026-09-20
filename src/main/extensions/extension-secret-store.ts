import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import type { ExtensionSecretStore } from './extension-service'
import { normalizeExtensionId } from './extension-paths'

type SecretRoot = Record<string, Record<string, string>>

export interface ExtensionSecretCryptography {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

export interface LegacyExtensionSecretSource {
  get(key: string): Promise<unknown>
  delete(key: string): Promise<void>
}

function secretConfigKey(extensionId: string, key: string): string {
  return 'extension:' + extensionId + ':secret:' + key
}

function parseRoot(value: string): SecretRoot {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([id, values]) =>
        values && typeof values === 'object' && !Array.isArray(values)
          ? [
              [
                id,
                Object.fromEntries(
                  Object.entries(values as Record<string, unknown>).flatMap(([key, item]) =>
                    typeof item === 'string' ? [[key, item]] : []
                  )
                )
              ]
            ]
          : []
      )
    )
  } catch {
    return {}
  }
}

function getSafeStorageCryptography(): ExtensionSecretCryptography {
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
    decrypt: (value) => safeStorage.decryptString(value)
  }
}

/**
 * Secret-only encrypted store for extensions. If the platform keychain is unavailable,
 * values stay in memory and legacy plaintext is deliberately retained for the next safe migration.
 * The host-owned config store remains the compatibility location for encrypted
 * extension secrets; extension lifecycle execution itself is Main-owned TypeScript.
 */
export class EncryptedExtensionSecretStore implements ExtensionSecretStore {
  private tail: Promise<void> = Promise.resolve()
  private memory: SecretRoot | undefined

  constructor(
    private readonly path: string,
    private readonly cryptography: ExtensionSecretCryptography = getSafeStorageCryptography(),
    private readonly legacy?: LegacyExtensionSecretSource
  ) {}

  async get(extensionId: string, key: string): Promise<string> {
    const id = normalizeExtensionId(extensionId)
    const root = await this.read()
    const current = root[id]?.[key]
    if (current !== undefined || !this.legacy) return current ?? ''
    const legacyKey = secretConfigKey(id, key)
    const legacyValue = await this.legacy.get(legacyKey)
    if (typeof legacyValue !== 'string') return ''
    await this.set(id, key, legacyValue)
    return legacyValue
  }

  set(extensionId: string, key: string, value: string): Promise<void> {
    const id = normalizeExtensionId(extensionId)
    return this.mutate((root) => {
      root[id] ??= {}
      root[id][key] = value
    })
  }

  delete(extensionId: string, key: string): Promise<void> {
    const id = normalizeExtensionId(extensionId)
    return this.mutate((root) => {
      delete root[id]?.[key]
      if (root[id] && Object.keys(root[id]).length === 0) delete root[id]
    })
  }

  private async read(): Promise<SecretRoot> {
    if (this.memory) return structuredClone(this.memory)
    if (!this.cryptography.available()) {
      this.memory = {}
      return {}
    }
    try {
      const decoded = this.cryptography.decrypt(await readFile(this.path))
      this.memory = parseRoot(decoded)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) this.memory = {}
      else this.memory = {}
    }
    return structuredClone(this.memory)
  }

  private mutate(change: (root: SecretRoot) => void): Promise<void> {
    const result = this.tail.then(async () => {
      const root = await this.read()
      change(root)
      this.memory = root
      if (!this.cryptography.available()) return
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = join(dirname(this.path), '.' + randomUUID() + '.extensions-secrets.bin')
      await writeFile(temporary, this.cryptography.encrypt(JSON.stringify(root)), { mode: 0o600 })
      await rename(temporary, this.path)
    })
    this.tail = result.catch(() => undefined)
    return result
  }
}
