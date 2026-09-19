import { app } from 'electron'
import { join } from 'node:path'
import { EncryptedExtensionSecretStore } from '../extensions/extension-secret-store'
import type { ExtensionSecretStore } from '../extensions/extension-service'

const STORE_ID = 'web-search'
const SECRET_KEY = 'api-key'
const MAX_SECRET_LENGTH = 4_096

export interface WebSearchSecretStatus {
  configured: boolean
  suffix: string | null
}

export interface WebSearchSecretBackend {
  get(extensionId: string, key: string): Promise<string>
  set(extensionId: string, key: string, value: string): Promise<void>
  delete(extensionId: string, key: string): Promise<void>
}

/**
 * Main-only store for the configured search key. The public status deliberately
 * exposes only presence and a short suffix; models and renderer state never get
 * the secret value after it has been submitted.
 */
export class WebSearchSecretStore {
  constructor(private readonly backend: WebSearchSecretBackend) {}

  async get(): Promise<string> {
    return await this.backend.get(STORE_ID, SECRET_KEY)
  }

  async status(): Promise<WebSearchSecretStatus> {
    const value = await this.get()
    return {
      configured: Boolean(value),
      suffix: value ? value.slice(-4) : null
    }
  }

  async set(value: unknown): Promise<WebSearchSecretStatus> {
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_SECRET_LENGTH)
      throw new Error('Invalid web search API key')
    await this.backend.set(STORE_ID, SECRET_KEY, value.trim())
    return await this.status()
  }

  async delete(): Promise<WebSearchSecretStatus> {
    await this.backend.delete(STORE_ID, SECRET_KEY)
    return { configured: false, suffix: null }
  }
}

let singleton: WebSearchSecretStore | undefined

/** Electron-safe lazy factory; startup imports do not touch userData or keychain state. */
export function getWebSearchSecretStore(): WebSearchSecretStore {
  if (!singleton) {
    const path = join(app.getPath('userData'), 'web', 'search-secrets.bin')
    const backend: ExtensionSecretStore = new EncryptedExtensionSecretStore(path)
    singleton = new WebSearchSecretStore(backend)
  }
  return singleton
}
