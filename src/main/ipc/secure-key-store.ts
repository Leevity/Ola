import { registerMessagePackHandler } from './messagepack-handler'
import { ConfigStore, type ConfigMutationResult } from '../config/config-store'
import {
  getProviderMainMirrorSnapshot,
  hydrateProviderMainMirror,
  updateProviderMainMirror
} from '../providers/provider-main-store'
import { getProviderSecretStore } from '../providers/provider-secret-store'
import { PROVIDER_STORE_KEY, type PersistedProviderState } from '../../shared/provider-contract'
import { decodePersistedStoreState } from './settings-handlers'

const configStore = new ConfigStore()

async function syncProviderSecrets(raw: unknown): Promise<void> {
  const decoded = decodePersistedStoreState<PersistedProviderState>(raw)
  if (!Array.isArray(decoded?.providers)) return
  const store = getProviderSecretStore()
  for (const provider of decoded.providers) {
    if (!provider || typeof provider.id !== 'string') continue
    if (Object.prototype.hasOwnProperty.call(provider, 'apiKey')) {
      const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : ''
      if (apiKey) await store.set(provider.id, apiKey)
      else await store.delete(provider.id)
    }
  }
}

export async function readConfig(): Promise<Record<string, unknown>> {
  try {
    const config = await configStore.read()
    hydrateProviderMainMirror(config)
    await syncProviderSecrets(config[PROVIDER_STORE_KEY])
    return config
  } catch (err) {
    console.error('[ConfigStore] Read error:', err)
    return {}
  }
}

export async function writeConfig(config: Record<string, unknown>): Promise<void> {
  const result = await configStore.write(config)
  if (!result.success) {
    throw new Error(result.error ?? 'Config write failed')
  }
  await syncProviderSecrets(config[PROVIDER_STORE_KEY])
}

export async function getConfigValue(key?: string): Promise<unknown> {
  return await configStore.get(key)
}

export async function setConfigValue(key: string, value: unknown): Promise<ConfigMutationResult> {
  const result = await configStore.set(key, value)
  if (result.success) {
    updateProviderMainMirror(key, value)
    if (key === PROVIDER_STORE_KEY) await syncProviderSecrets(value)
  }
  return result
}

export async function deleteConfigValue(key: string): Promise<ConfigMutationResult> {
  return await configStore.delete(key)
}

export function registerConfigHandlers(): void {
  registerMessagePackHandler('config:read', async () => await readConfig())

  registerMessagePackHandler<Record<string, unknown>, ConfigMutationResult>(
    'config:write',
    async (config) => {
      await writeConfig(config)
      return { success: true }
    }
  )

  registerMessagePackHandler<string | undefined>('config:get', async (key) => {
    return await getConfigValue(key)
  })

  registerMessagePackHandler<{ key: string; value: unknown }>('config:set', async (args) => {
    return await setConfigValue(args.key, args.value)
  })

  registerMessagePackHandler<{ key: string }, ConfigMutationResult>(
    'config:delete',
    async (args) => await deleteConfigValue(args.key)
  )

  registerMessagePackHandler('provider:mirror-snapshot', async () => {
    await readConfig()
    return getProviderMainMirrorSnapshot()
  })
}
