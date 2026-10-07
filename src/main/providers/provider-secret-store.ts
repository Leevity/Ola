import { app } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { EncryptedExtensionSecretStore } from '../extensions/extension-secret-store'
import type { ExtensionSecretStore } from '../extensions/extension-service'
import { olaDataRoot } from '../lib/ola-data-root'

const SECRET_KEY = 'api-key'
const AUTH_BUNDLE_KEY = 'auth-v1'
const MAX_SECRET_LENGTH = 16 * 1024
const MAX_AUTH_BUNDLE_LENGTH = 1024 * 1024

function providerSecretId(providerId: string): string {
  return `provider-${createHash('sha256').update(providerId).digest('hex').slice(0, 32)}`
}

function validateProviderId(providerId: string): string {
  const value = providerId.trim()
  if (!value || value.length > 256) throw new Error('Invalid provider id')
  return value
}

export interface ProviderSecretStatus {
  configured: boolean
  suffix: string | null
}

/** Main-only provider secret gateway. Provider IDs are hashed before reaching the generic vault. */
export class ProviderSecretStore {
  constructor(private readonly backend: ExtensionSecretStore) {}

  isPersistent(): boolean {
    return (
      'isPersistent' in this.backend &&
      typeof this.backend.isPersistent === 'function' &&
      this.backend.isPersistent()
    )
  }

  async getAuthBundle(providerId: string): Promise<string> {
    return await this.backend.get(providerSecretId(validateProviderId(providerId)), AUTH_BUNDLE_KEY)
  }

  async setAuthBundle(providerId: string, value: string): Promise<void> {
    if (!value || value.length > MAX_AUTH_BUNDLE_LENGTH)
      throw new Error('Invalid provider auth bundle')
    await this.backend.set(providerSecretId(validateProviderId(providerId)), AUTH_BUNDLE_KEY, value)
  }

  async deleteAuthBundle(providerId: string): Promise<void> {
    await this.backend.delete(providerSecretId(validateProviderId(providerId)), AUTH_BUNDLE_KEY)
  }

  async get(providerId: string): Promise<string> {
    const id = validateProviderId(providerId)
    const bundle = await this.backend.get(providerSecretId(id), AUTH_BUNDLE_KEY)
    if (bundle) {
      try {
        const parsed: unknown = JSON.parse(bundle)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const apiKey = (parsed as Record<string, unknown>).apiKey
          return typeof apiKey === 'string' ? apiKey : ''
        }
      } catch {
        return ''
      }
    }
    return await this.backend.get(providerSecretId(id), SECRET_KEY)
  }

  async status(providerId: string): Promise<ProviderSecretStatus> {
    const value = await this.get(providerId)
    return { configured: Boolean(value), suffix: value ? value.slice(-4) : null }
  }

  async set(providerId: string, value: string): Promise<ProviderSecretStatus> {
    const id = validateProviderId(providerId)
    if (!value.trim() || value.length > MAX_SECRET_LENGTH)
      throw new Error('Invalid provider secret')
    await this.backend.set(providerSecretId(id), SECRET_KEY, value)
    return await this.status(id)
  }

  async delete(providerId: string): Promise<void> {
    const id = validateProviderId(providerId)
    await this.backend.delete(providerSecretId(id), SECRET_KEY)
  }
}

let singleton: ProviderSecretStore | undefined

class InMemorySecretBackend implements ExtensionSecretStore {
  private readonly values = new Map<string, string>()

  async get(extensionId: string, key: string): Promise<string> {
    return this.values.get(`${extensionId}:${key}`) ?? ''
  }

  async set(extensionId: string, key: string, value: string): Promise<void> {
    this.values.set(`${extensionId}:${key}`, value)
  }

  async delete(extensionId: string, key: string): Promise<void> {
    this.values.delete(`${extensionId}:${key}`)
  }
}

/** Lazy factory: importing provider resolution must not touch keychain state before app ready. */
export function getProviderSecretStore(): ProviderSecretStore {
  if (!singleton) {
    try {
      const userData =
        process.env.OLA_E2E_DATA_ROOT !== undefined
          ? olaDataRoot()
          : typeof app?.getPath === 'function'
            ? app.getPath('userData')
            : ''
      singleton = userData
        ? new ProviderSecretStore(
            new EncryptedExtensionSecretStore(join(userData, 'providers', 'secrets.bin'))
          )
        : new ProviderSecretStore(new InMemorySecretBackend())
    } catch {
      // Standalone runtime tests and pre-ready imports must not fail merely
      // because Electron's userData/keychain is unavailable. Values remain
      // session-only until the Main process can use encrypted storage.
      singleton = new ProviderSecretStore(new InMemorySecretBackend())
    }
  }
  return singleton
}
