import { ipcMain } from 'electron'
import type {
  SyncConfig,
  SyncConflictResolution,
  SyncProviderConfig,
  SyncRunMode
} from '../../shared/sync-types'
import { getActiveRunJobIds } from '../cron/cron-scheduler'
import { readSyncConfig, writeSyncConfig } from '../sync/sync-config'
import { syncEngine } from '../sync/sync-engine'
import { assertLegacySyncIpcOwner } from '../sync/sync-ipc-authorization'
import { getSidecarManager } from './sidecar-manager'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

let autoSyncTimer: ReturnType<typeof setInterval> | null = null
let handoverQuiescing = false

function normalizeRunMode(value: unknown): SyncRunMode {
  return value === 'push' || value === 'pull' || value === 'sync' ? value : 'sync'
}

function stopAutoSyncTimer(): void {
  if (!autoSyncTimer) return
  clearInterval(autoSyncTimer)
  autoSyncTimer = null
}

async function shouldDeferAutoSync(): Promise<boolean> {
  const status = await syncEngine.getStatus()
  if (status.running || status.pendingConflicts.length > 0) return true
  if (getActiveRunJobIds().length > 0) return true
  return getSidecarManager().hasActiveRuns()
}

function registerSyncMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (event, bytes: Uint8Array) => {
    assertLegacySyncIpcOwner(event)
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args))
  })
}

export async function configureAutoSyncTimer(): Promise<void> {
  stopAutoSyncTimer()
  if (handoverQuiescing) return
  const config = await readSyncConfig()
  if (handoverQuiescing) return
  const provider = config.providers.find((item) => item.id === config.activeProviderId)
  if (!provider?.enabled || !provider.webdav.autoSyncEnabled) return

  const intervalMs = Math.max(5, provider.webdav.syncIntervalMinutes) * 60 * 1000
  autoSyncTimer = setInterval(() => {
    void (async () => {
      if (handoverQuiescing) return
      if (await shouldDeferAutoSync()) return
      if (handoverQuiescing) return
      await syncEngine.run('sync')
    })().catch((error) => {
      console.warn('[SyncEngine] automatic run failed', error)
    })
  }, intervalMs)
}

export async function quiesceLegacySyncForHandover(): Promise<void> {
  handoverQuiescing = true
  stopAutoSyncTimer()
  await syncEngine.quiesceForHandover()
}

export function registerSyncHandlers(): void {
  registerSyncMessagePackHandler<undefined>('sync:config:get', () => readSyncConfig())

  registerSyncMessagePackHandler<SyncConfig>('sync:config:set', async (config) => {
    const next = await writeSyncConfig(config)
    await configureAutoSyncTimer()
    return next
  })

  registerSyncMessagePackHandler<undefined>('sync:providers:list', () =>
    syncEngine.getProviderDescriptors()
  )

  registerSyncMessagePackHandler<SyncProviderConfig | undefined>(
    'sync:connection:test',
    (provider) => {
      return syncEngine.testConnection(provider)
    }
  )

  registerSyncMessagePackHandler<undefined>('sync:status', () => syncEngine.getStatus())

  registerSyncMessagePackHandler<{ mode?: unknown } | undefined>('sync:run', (args) => {
    return syncEngine.run(normalizeRunMode(args?.mode))
  })

  registerSyncMessagePackHandler<{ resolutions?: SyncConflictResolution[] } | undefined>(
    'sync:conflicts:resolve',
    (args) => {
      return syncEngine.resolveConflicts(Array.isArray(args?.resolutions) ? args.resolutions : [])
    }
  )

  void configureAutoSyncTimer().catch((error) => {
    console.warn('[SyncEngine] automatic timer setup failed', error)
  })
}
