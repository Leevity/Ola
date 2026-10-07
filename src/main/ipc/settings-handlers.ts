import { BrowserWindow, session } from 'electron'
import { SettingsStore } from '../settings/settings-store'
import { registerMessagePackHandler } from './messagepack-handler'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
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

function enqueueSettingsMutation(operation: () => Promise<void>): Promise<void> {
  const previous = pendingWrite ?? Promise.resolve()
  const running = previous.catch(() => undefined).then(operation)
  const tracked = running.finally(() => {
    if (pendingWrite === tracked) pendingWrite = null
  })
  pendingWrite = tracked
  return tracked
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function broadcastSettingsChanged(key: string | null): void {
  if (typeof BrowserWindow?.getAllWindows !== 'function') return
  safeSendMessagePackToAllWindows('settings:changed', { key })
}

type PersistedStatePatch = {
  set: Record<string, unknown>
  remove: string[]
  setPaths?: Array<{ path: string[]; value: unknown }>
  removePaths?: string[][]
  version?: number
}

function validatePersistedStateKey(key: string): void {
  if (!key || key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key))
    throw new Error('INVALID_SETTINGS_STATE_KEY')
}

function validatePersistedStatePath(path: unknown): asserts path is string[] {
  if (!Array.isArray(path) || path.length < 2 || path.length > 16)
    throw new Error('INVALID_SETTINGS_STATE_PATH')
  for (const key of path) {
    if (typeof key !== 'string') throw new Error('INVALID_SETTINGS_STATE_PATH')
    validatePersistedStateKey(key)
  }
}

function applyNestedStateChange(
  state: Record<string, unknown>,
  path: string[],
  value: unknown,
  remove: boolean
): void {
  let current = state
  for (const key of path.slice(0, -1)) {
    const existing = current[key]
    if (!isPlainRecord(existing)) {
      if (remove) return
      current[key] = {}
    } else {
      current[key] = { ...existing }
    }
    current = current[key] as Record<string, unknown>
  }
  const last = path[path.length - 1]
  if (remove) delete current[last]
  else current[last] = value
}

export async function mergePersistedSettingsState(patch: PersistedStatePatch): Promise<void> {
  if (!isPlainRecord(patch?.set) || !Array.isArray(patch.remove))
    throw new Error('INVALID_SETTINGS_STATE_PATCH')
  if (patch.version !== undefined && (!Number.isSafeInteger(patch.version) || patch.version < 0))
    throw new Error('INVALID_SETTINGS_STATE_VERSION')
  for (const key of Object.keys(patch.set)) validatePersistedStateKey(key)
  for (const key of patch.remove) {
    if (typeof key !== 'string') throw new Error('INVALID_SETTINGS_STATE_KEY')
    validatePersistedStateKey(key)
  }
  const setPaths = patch.setPaths ?? []
  const removePaths = patch.removePaths ?? []
  if (!Array.isArray(setPaths) || !Array.isArray(removePaths))
    throw new Error('INVALID_SETTINGS_STATE_PATCH')
  for (const entry of setPaths) {
    if (!isPlainRecord(entry)) throw new Error('INVALID_SETTINGS_STATE_PATH')
    validatePersistedStatePath(entry.path)
  }
  for (const path of removePaths) validatePersistedStatePath(path)
  await enqueueSettingsMutation(async () => {
    const current = await initializeSettingsCache()
    const persisted = isPlainRecord(current['ola-settings']) ? current['ola-settings'] : {}
    const previousState = isPlainRecord(persisted.state) ? persisted.state : {}
    const state = { ...previousState, ...patch.set }
    for (const key of patch.remove) delete state[key]
    for (const entry of setPaths) applyNestedStateChange(state, entry.path, entry.value, false)
    for (const path of removePaths) applyNestedStateChange(state, path, undefined, true)
    const nextPersisted = {
      ...persisted,
      state,
      version: Math.max(
        typeof persisted.version === 'number' && Number.isSafeInteger(persisted.version)
          ? persisted.version
          : 29,
        patch.version ?? 29
      )
    }
    const result = await settingsStore.set('ola-settings', nextPersisted)
    if (!result.success) throw new Error(result.error || 'Settings merge failed')
    settingsCache = { ...current, 'ola-settings': nextPersisted }
  })
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
  while (pendingWrite) {
    const current = pendingWrite
    await current.catch((err) => {
      console.error('[Settings] Pending native write failed:', err)
    })
    if (pendingWrite === current) return
  }
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
  await enqueueSettingsMutation(async () => {
    const current = await initializeSettingsCache()
    const next = { ...current }
    if (value === undefined || value === null) delete next[key]
    else next[key] = value
    const result = await settingsStore.set(key, value)
    if (!result.success) throw new Error(result.error || 'Settings set failed')
    settingsCache = next
  })
}

export async function writeSettingsValue(root: Record<string, unknown>): Promise<void> {
  await enqueueSettingsMutation(async () => {
    const result = await settingsStore.write(root)
    if (!result.success) throw new Error(result.error)
    settingsCache = root
    settingsHydrated = true
  })
}

export function registerSettingsHandlers(): void {
  void initializeSettingsCache()

  registerMessagePackHandler('settings:read', async () => await initializeSettingsCache())

  registerMessagePackHandler<Record<string, unknown>, { success: boolean; error?: string }>(
    'settings:write',
    async (root) => {
      try {
        await writeSettingsValue(root)
        broadcastSettingsChanged(null)
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

  registerMessagePackHandler<{
    key: string
    value?: unknown
    patch?: PersistedStatePatch
  }>('settings:set', async (args) => {
    if (args.patch !== undefined) {
      if (args.key !== 'ola-settings') throw new Error('INVALID_SETTINGS_STATE_PATCH_TARGET')
      await mergePersistedSettingsState(args.patch)
    } else {
      await setSettingsValue(args.key, args.value)
    }
    broadcastSettingsChanged(args.key)

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
        broadcastSettingsChanged(key)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
