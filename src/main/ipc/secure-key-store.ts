import { registerMessagePackHandler } from './messagepack-handler'
import { ConfigStore, type ConfigMutationResult } from '../config/config-store'
import {
  getProviderMainMirrorSnapshot,
  hydrateProviderMainMirror,
  updateProviderMainMirror
} from '../providers/provider-main-store'
import { getProviderSecretStore } from '../providers/provider-secret-store'
import {
  hydrateProviderCredentials,
  splitProviderCredentials,
  type StoredProviderCredentials
} from '../providers/provider-auth-persistence'
import { PROVIDER_STORE_KEY, type PersistedProviderState } from '../../shared/provider-contract'
import { decodePersistedStoreState } from './settings-handlers'

const configStore = new ConfigStore()
let providerMutationTail: Promise<void> = Promise.resolve()
let providerVaultReadError: string | null = null

function serializeProviderMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = providerMutationTail.then(operation)
  providerMutationTail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function providerIds(raw: unknown): string[] {
  const decoded = decodePersistedStoreState<PersistedProviderState>(raw)
  if (!Array.isArray(decoded?.providers)) return []
  return decoded.providers.flatMap((provider) =>
    provider && typeof provider.id === 'string' && provider.id.trim() ? [provider.id] : []
  )
}

async function readAuthBundles(raw: unknown): Promise<Record<string, StoredProviderCredentials>> {
  const bundles: Record<string, StoredProviderCredentials> = Object.create(null)
  const store = getProviderSecretStore()
  for (const id of providerIds(raw)) {
    const saved = await store.getAuthBundle(id)
    if (!saved) continue
    try {
      const parsed: unknown = JSON.parse(saved)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        bundles[id] = parsed as StoredProviderCredentials
      }
    } catch {
      // An unreadable credential bundle must not be projected into a provider.
    }
  }
  return bundles
}

async function hydrateAndMigrateProviderState(raw: unknown): Promise<unknown> {
  const store = getProviderSecretStore()
  const split = splitProviderCredentials(raw)
  const legacyIds = Object.keys(split.credentials)
  if (legacyIds.length > 0 && store.isPersistent()) {
    try {
      for (const id of legacyIds) {
        await store.setAuthBundle(id, JSON.stringify(split.credentials[id]))
      }
      const result = await configStore.set(PROVIDER_STORE_KEY, split.publicState)
      if (result.success) raw = split.publicState
    } catch (error) {
      console.error('[ConfigStore] Provider credential migration failed:', error)
    }
  }
  const bundles = await readAuthBundles(raw)
  return hydrateProviderCredentials(raw, bundles)
}

async function commitProviderState(
  raw: unknown,
  commit: (publicState: unknown) => Promise<ConfigMutationResult>
): Promise<ConfigMutationResult> {
  const store = getProviderSecretStore()
  const current = await configStore.get(PROVIDER_STORE_KEY)
  if (current !== null && current !== undefined) {
    // The renderer can send an empty initial snapshot before hydration. Never
    // let it replace persisted providers when their vault cannot be opened.
    try {
      hydrateProviderCredentials(current, await readAuthBundles(current))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const previous = await readAuthBundles(raw)
  const hydrated = hydrateProviderCredentials(raw, previous)
  const split = splitProviderCredentials(hydrated)
  const ids = providerIds(split.publicState)
  if (ids.some((id) => split.credentials[id] || previous[id]) && !store.isPersistent()) {
    return { success: false, error: 'Encrypted provider storage is unavailable' }
  }
  const priorValues = new Map<string, string>()
  try {
    for (const id of ids) {
      priorValues.set(id, await store.getAuthBundle(id))
      if (store.isPersistent()) {
        await store.setAuthBundle(id, JSON.stringify(split.credentials[id] ?? {}))
      }
    }
    const result = await commit(split.publicState)
    if (!result.success) throw new Error(result.error)
    updateProviderMainMirror(PROVIDER_STORE_KEY, hydrated)
    return result
  } catch (error) {
    for (const [id, value] of priorValues) {
      try {
        if (value) await store.setAuthBundle(id, value)
        else await store.deleteAuthBundle(id)
      } catch (rollbackError) {
        console.error('[ConfigStore] Provider credential rollback failed:', rollbackError)
      }
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readConfig(): Promise<Record<string, unknown>> {
  return await serializeProviderMutation(async () => {
    const config = await configStore.read()
    try {
      if (config[PROVIDER_STORE_KEY] !== undefined) {
        config[PROVIDER_STORE_KEY] = await hydrateAndMigrateProviderState(
          config[PROVIDER_STORE_KEY]
        )
      }
      providerVaultReadError = null
      hydrateProviderMainMirror(config)
      return config
    } catch (err) {
      providerVaultReadError = err instanceof Error ? err.message : String(err)
      console.error('[ConfigStore] Provider credential read error:', err)
      updateProviderMainMirror(PROVIDER_STORE_KEY, null)
      // Keep the original root intact. Other services may read unrelated
      // configuration, and a full-root writer must fail on the vault check.
      return config
    }
  })
}

export async function writeConfig(config: Record<string, unknown>): Promise<void> {
  const providerState = config[PROVIDER_STORE_KEY]
  const result =
    providerState === undefined
      ? await serializeProviderMutation(async () => {
          const current = await configStore.read()
          // A full-root write from an unrelated settings flow must not erase
          // the provider reference while its credential vault is unavailable.
          const next =
            current[PROVIDER_STORE_KEY] === undefined
              ? config
              : { ...config, [PROVIDER_STORE_KEY]: current[PROVIDER_STORE_KEY] }
          return await configStore.write(next)
        })
      : await serializeProviderMutation(() =>
          commitProviderState(
            providerState,
            async (publicState) =>
              await configStore.write({ ...config, [PROVIDER_STORE_KEY]: publicState })
          )
        )
  if (!result.success) {
    throw new Error(result.error ?? 'Config write failed')
  }
}

export async function getConfigValue(key?: string): Promise<unknown> {
  if (!key || key === PROVIDER_STORE_KEY) {
    const config = await readConfig()
    if (providerVaultReadError) throw new Error('Provider credential vault is unavailable')
    return key ? (config[key] ?? null) : config
  }
  return await configStore.get(key)
}

export async function setConfigValue(key: string, value: unknown): Promise<ConfigMutationResult> {
  if (key === PROVIDER_STORE_KEY) {
    return await serializeProviderMutation(() =>
      commitProviderState(value, async (publicState) => await configStore.set(key, publicState))
    )
  }
  const result = await configStore.set(key, value)
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
    return {
      ...getProviderMainMirrorSnapshot(),
      credentialVaultUnavailable: providerVaultReadError !== null
    }
  })
}
