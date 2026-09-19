import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { getRegisteredWindowWorkspace } from '../window-ipc'

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
