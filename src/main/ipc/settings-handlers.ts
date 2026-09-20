import { session } from 'electron'
import { SettingsStore } from '../settings/settings-store'
import { registerMessagePackHandler } from './messagepack-handler'
import {
  sanitizePermissionPolicy,
  toPermissionPolicySnapshot,
  type PermissionPolicySnapshot
} from '../../shared/permission-policy'

let settingsCache: Record<string, unknown> | null = null
let settingsHydrated = false
let hydratePromise: Promise<Record<string, unknown>> | null = null
let pendingWrite: Promise<unknown> | null = null
const settingsStore = new SettingsStore()

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export async function initializeSettingsCache(): Promise<Record<string, unknown>> {
  if (settingsHydrated && settingsCache) return settingsCache
  if (hydratePromise) return hydratePromise

  return await reloadSettingsCache()
}

export async function reloadSettingsCache(): Promise<Record<string, unknown>> {
  if (hydratePromise) return hydratePromise

  hydratePromise = settingsStore
    .read()
    .then((settings) => {
      settingsCache = isPlainRecord(settings) ? settings : {}
      settingsHydrated = true
      return settingsCache
    })
    .catch((err) => {
      if (!settingsCache) settingsCache = {}
      console.error('[Settings] TS read error:', err)
      return settingsCache
    })
    .finally(() => {
      hydratePromise = null
    })

  return await hydratePromise
}

// Synchronous callers read the hydrated in-memory snapshot. Startup now hydrates this before use.
export function readSettings(): Record<string, unknown> {
  if (settingsCache) return settingsCache
  settingsCache = {}
  void initializeSettingsCache()
  return settingsCache
}

export function decodePersistedStoreState<T>(raw: unknown): T | null {
  if (raw == null) return null

  let parsed = raw
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }

  if (!parsed || typeof parsed !== 'object') return null
  if ('state' in (parsed as Record<string, unknown>)) {
    return ((parsed as Record<string, unknown>).state as T) ?? null
  }

  return parsed as T
}

export function readPersistedSettingsState(): Record<string, unknown> {
  const root = readSettings()
  return decodePersistedStoreState<Record<string, unknown>>(root['ola-settings']) ?? {}
}

/**
 * Read the one legacy secret that was historically persisted with the
 * renderer's Zustand settings. New code must use the encrypted Main store;
 * this is intentionally only a migration seam.
 */
export async function readLegacyWebSearchApiKey(): Promise<string> {
  await initializeSettingsCache()
  const value = readPersistedSettingsState().webSearchApiKey
  return typeof value === 'string' ? value.trim() : ''
}

/** Remove the legacy plaintext value after it has been safely imported. */
export async function clearLegacyWebSearchApiKey(): Promise<void> {
  const root = await initializeSettingsCache()
  const persisted = decodePersistedStoreState<Record<string, unknown>>(root['ola-settings'])
  if (!persisted || !Object.prototype.hasOwnProperty.call(persisted, 'webSearchApiKey')) return

  const nextState = { ...persisted }
  delete nextState.webSearchApiKey
  const raw = root['ola-settings']
  const nextPersisted =
    isPlainRecord(raw) && Object.prototype.hasOwnProperty.call(raw, 'state')
      ? { ...raw, state: nextState }
      : nextState
  await setSettingsValue('ola-settings', nextPersisted)
}

export function readShellEnvironmentVariablesText(): string {
  const persistedSettings = readPersistedSettingsState()
  return typeof persistedSettings.shellEnvironmentVariablesText === 'string'
    ? persistedSettings.shellEnvironmentVariablesText
    : ''
}

export function readPermissionPolicySnapshot(): PermissionPolicySnapshot | undefined {
  return toPermissionPolicySnapshot(
    sanitizePermissionPolicy(readPersistedSettingsState().permissionPolicy)
  )
}

export function readProviderRetryMaxAttempts(): number {
  const value = readPersistedSettingsState().providerRetryMaxAttempts
  if (typeof value !== 'number' || !Number.isFinite(value)) return 4
  return Math.min(6, Math.max(1, Math.floor(value)))
}

export async function flushSettingsSync(): Promise<void> {
  if (!pendingWrite) return
  await pendingWrite.catch((err) => {
    console.error('[Settings] Pending native write failed:', err)
  })
}

function normalizeProxyUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function applySystemProxy(proxyUrl: string): Promise<void> {
  try {
    await session.defaultSession.setProxy({ proxyRules: proxyUrl })
    console.log(
      proxyUrl
        ? `[Settings] System proxy configured: ${proxyUrl}`
        : '[Settings] System proxy cleared'
    )
  } catch (err) {
    console.error('[Settings] Failed to configure system proxy:', err)
  }
}

export async function setSettingsValue(key: string, value: unknown): Promise<void> {
  const settings = await initializeSettingsCache()
  if (value === undefined || value === null) {
    delete settings[key]
  } else {
    settings[key] = value
  }
  settingsCache = settings

  pendingWrite = settingsStore
    .set(key, value)
    .then((result) => {
      if (!result.success) {
        throw new Error(result.error || 'Settings set failed')
      }
    })
    .finally(() => {
      pendingWrite = null
    })
  await pendingWrite
}

export async function writeSettingsValue(root: Record<string, unknown>): Promise<void> {
  const result = await settingsStore.write(root)
  if (!result.success) throw new Error(result.error)
  settingsCache = root
  settingsHydrated = true
}

export function registerSettingsHandlers(): void {
  void initializeSettingsCache()

  registerMessagePackHandler('settings:read', async () => await initializeSettingsCache())

  registerMessagePackHandler<Record<string, unknown>, { success: boolean; error?: string }>(
    'settings:write',
    async (root) => {
      try {
        await writeSettingsValue(root)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  registerMessagePackHandler<string | undefined>('settings:get', async (key) => {
    const settings = await initializeSettingsCache()
    if (key) return settings[key]
    return settings
  })

  registerMessagePackHandler<{ key: string; value: unknown }>('settings:set', async (args) => {
    await setSettingsValue(args.key, args.value)

    if (args.key === 'systemProxyUrl') {
      await applySystemProxy(normalizeProxyUrl(args.value))
      return { success: true }
    }

    return { success: true }
  })

  registerMessagePackHandler<{ key: string }, { success: boolean; error?: string }>(
    'settings:delete',
    async ({ key }) => {
      try {
        await setSettingsValue(key, null)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
