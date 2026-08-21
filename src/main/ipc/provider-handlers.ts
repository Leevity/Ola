import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { listProviderHealth, resetProviderHealth } from '../provider/provider-health-registry'
import { resolveProviderFallback } from '../provider/provider-fallback-resolver'
import type { ProviderCandidate } from '../../shared/provider-health'

function isTrustedProviderIpcSender(event: IpcMainInvokeEvent): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  return (
    ownerWindow !== null &&
    !ownerWindow.isDestroyed() &&
    ownerWindow.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame
  )
}

export function registerProviderHandlers(): void {
  ipcMain.handle('provider:health', (event) => {
    if (!isTrustedProviderIpcSender(event)) return { providers: [], generatedAt: Date.now() }
    return listProviderHealth()
  })
  ipcMain.handle('provider:health:reset', (event, args?: { providerKey?: string }) => {
    if (!isTrustedProviderIpcSender(event))
      return { success: false, error: 'Unauthorized provider IPC sender' }
    resetProviderHealth(args?.providerKey)
    return { success: true }
  })
  ipcMain.handle(
    'provider:fallback:resolve',
    (
      event,
      args?: {
        preferredProviderId?: string | null
        preferredModelId?: string | null
        candidates?: ProviderCandidate[]
        requireVision?: boolean
        requireComputerUse?: boolean
      }
    ) => {
      if (!isTrustedProviderIpcSender(event)) {
        return { selected: null, fallbacks: [], reason: 'none' as const }
      }
      const candidates = Array.isArray(args?.candidates) ? args.candidates.slice(0, 100) : []
      return resolveProviderFallback({
        preferredProviderId: args?.preferredProviderId,
        preferredModelId: args?.preferredModelId,
        candidates,
        health: listProviderHealth().providers,
        requireVision: args?.requireVision === true,
        requireComputerUse: args?.requireComputerUse === true
      })
    }
  )
}
