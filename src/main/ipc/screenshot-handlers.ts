import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { DESKTOP_SCREENSHOT_CAPTURE, captureDesktopScreenshot } from './desktop-control'
import { registerMessagePackHandler } from './messagepack-handler'

function isTrustedDesktopIpcSender(event: IpcMainInvokeEvent): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  return (
    ownerWindow !== null &&
    !ownerWindow.isDestroyed() &&
    ownerWindow.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame
  )
}

export function registerScreenshotHandlers(): void {
  registerMessagePackHandler<undefined>(DESKTOP_SCREENSHOT_CAPTURE, async (_args, event) => {
    if (!isTrustedDesktopIpcSender(event)) {
      return { success: false, error: 'Unauthorized desktop IPC sender' }
    }
    return await captureDesktopScreenshot()
  })
}
