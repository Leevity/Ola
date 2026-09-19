import { registerMessagePackHandler } from './messagepack-handler'
import { ConfigStore, type ConfigMutationResult } from '../config/config-store'
import {
  getProviderMainMirrorSnapshot,
  hydrateProviderMainMirror,
  updateProviderMainMirror
} from '../providers/provider-main-store'

const configStore = new ConfigStore()

export async function readConfig(): Promise<Record<string, unknown>> {
  try {
    const config = await configStore.read()
    hydrateProviderMainMirror(config)
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
}

export async function getConfigValue(key?: string): Promise<unknown> {
  return await configStore.get(key)
}

export async function setConfigValue(key: string, value: unknown): Promise<ConfigMutationResult> {
  const result = await configStore.set(key, value)
  if (result.success) updateProviderMainMirror(key, value)
  return result
}

export async function deleteConfigValue(key: string): Promise<ConfigMutationResult> {
  return await configStore.delete(key)
}

export function registerConfigHandlers(): void {
  registerMessagePackHandler<string | undefined>('config:get', async (key) => {
    return await getConfigValue(key)
  })

  registerMessagePackHandler<{ key: string; value: unknown }>('config:set', async (args) => {
    return await setConfigValue(args.key, args.value)
  })

  registerMessagePackHandler('provider:mirror-snapshot', async () => {
    await readConfig()
    return getProviderMainMirrorSnapshot()
  })
}
