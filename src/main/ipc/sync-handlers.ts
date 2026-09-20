import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  SyncConfig,
  SyncConflictResolution,
  SyncProviderConfig,
  SyncRunMode
} from '../../shared/sync-types'
import { getActiveRunJobIds } from '../cron/cron-scheduler'
import { readSyncConfig, writeSyncConfig } from '../sync/sync-config'
import { syncEngine } from '../sync/sync-engine'
import {
  assertLegacySyncIpcOwner,
  assertWorkspaceSyncIpcOwner
} from '../sync/sync-ipc-authorization'
import { businessWriteCanary } from '../db/business-write-canary'
import { loadOfflineWorkspaceIds, loadWorkspaceSyncScope } from '../remote/account-client'
import { WebDavProvider } from '../sync/webdav-provider'
import { runWorkspaceSync } from '../../runtime/storage/workspace-sync-run'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

let autoSyncTimer: ReturnType<typeof setInterval> | null = null
let handoverQuiescing = false
const workspaceAutoSyncInFlight = new Set<string>()

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
  return false
}

async function runWorkspaceAutoSync(
  workspaceId: string,
  provider: SyncProviderConfig,
  deviceId: string
): Promise<void> {
  if (workspaceAutoSyncInFlight.has(workspaceId)) return
  const repository = businessWriteCanary()
  if (!repository || !provider.enabled || provider.type !== 'webdav' || !provider.webdav.serverUrl)
    return
  workspaceAutoSyncInFlight.add(workspaceId)
  try {
    const scope = await loadWorkspaceSyncScope(workspaceId)
    await runWorkspaceSync({
      repository,
      transport: new WebDavProvider(),
      config: provider.webdav,
      scope,
      providerId: provider.id,
      deviceId,
      appVersion: app.getVersion(),
      createdAt: Date.now(),
      authorize: async () => {
        await loadWorkspaceSyncScope(workspaceId)
      }
    })
  } finally {
    workspaceAutoSyncInFlight.delete(workspaceId)
  }
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

function registerWorkspaceSyncMessagePackHandler(
  handler: (
    args: { workspaceId?: unknown; resolutions?: unknown } | undefined,
    event: IpcMainInvokeEvent
  ) => Promise<unknown>
): void {
  ipcMain.handle(toMessagePackChannel('sync:workspace-run'), async (event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{ workspaceId?: unknown; resolutions?: unknown }>(bytes)
    return encodeMessagePackPayload(await handler(args, event))
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
      const currentConfig = await readSyncConfig()
      const activeProvider = currentConfig.providers.find(
        (item) => item.id === currentConfig.activeProviderId
      )
      if (businessWriteCanary() && activeProvider?.type === 'webdav') {
        const workspaceIds = await loadOfflineWorkspaceIds()
        if (workspaceIds.size === 0) {
          // Without a managed account directory, retain the local personal v1
          // path for users who are offline or have not signed in.
          await syncEngine.run('sync')
          return
        }
        for (const workspaceId of new Set(['local-personal', ...workspaceIds])) {
          await runWorkspaceAutoSync(workspaceId, activeProvider, currentConfig.deviceId)
        }
      } else {
        await syncEngine.run('sync')
      }
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

  registerWorkspaceSyncMessagePackHandler(async (args, event) => {
    const workspaceId = typeof args?.workspaceId === 'string' ? args.workspaceId : ''
    await assertWorkspaceSyncIpcOwner(event, workspaceId)
    const repository = businessWriteCanary()
    if (!repository) throw new Error('SYNC_TS_OWNERSHIP_REQUIRED')
    const scope = await loadWorkspaceSyncScope(workspaceId)
    const config = await readSyncConfig()
    const provider = config.providers.find((item) => item.id === config.activeProviderId)
    if (!provider?.enabled || provider.type !== 'webdav' || !provider.webdav.serverUrl)
      throw new Error('SYNC_PROVIDER_UNAVAILABLE')
    const resolutions = Array.isArray(args?.resolutions)
      ? (args.resolutions as SyncConflictResolution[])
      : undefined
    return runWorkspaceSync({
      repository,
      transport: new WebDavProvider(),
      config: provider.webdav,
      scope,
      providerId: provider.id,
      deviceId: config.deviceId,
      appVersion: app.getVersion(),
      createdAt: Date.now(),
      resolutions,
      authorize: async () => {
        await assertWorkspaceSyncIpcOwner(event, workspaceId)
      }
    })
  })

  void configureAutoSyncTimer().catch((error) => {
    console.warn('[SyncEngine] automatic timer setup failed', error)
  })
}
