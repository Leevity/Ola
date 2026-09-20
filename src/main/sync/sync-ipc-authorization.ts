import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { getRegisteredWindowWorkspace } from '../window-ipc'
import { loadOfflineWorkspaceIds } from '../remote/account-client'

/** Legacy WebDAV sync is app-global; a team workspace cannot own its credentials or mutations. */
export function assertLegacySyncIpcOwner(event: IpcMainInvokeEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (
    !window ||
    window.isDestroyed() ||
    window.webContents !== event.sender ||
    event.senderFrame !== event.sender.mainFrame ||
    getRegisteredWindowWorkspace(window) !== 'local-personal'
  ) {
    throw new Error('SYNC_WORKSPACE_UNAVAILABLE')
  }
}

export async function assertWorkspaceSyncIpcOwner(
  event: IpcMainInvokeEvent,
  workspaceId: string
): Promise<void> {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (
    !window ||
    window.isDestroyed() ||
    window.webContents !== event.sender ||
    event.senderFrame !== event.sender.mainFrame ||
    !workspaceId ||
    getRegisteredWindowWorkspace(window) !== workspaceId
  ) {
    throw new Error('SYNC_WORKSPACE_UNAVAILABLE')
  }
  const allowed = await loadOfflineWorkspaceIds()
  if (!allowed.has(workspaceId)) throw new Error('SYNC_WORKSPACE_UNAVAILABLE')
}
