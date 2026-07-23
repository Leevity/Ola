import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  DESKTOP_INPUT_CLICK,
  DESKTOP_INPUT_SCROLL,
  DESKTOP_INPUT_STATUS,
  DESKTOP_INPUT_TYPE,
  desktopInputClick,
  desktopInputScroll,
  desktopInputType,
  isDesktopInputAvailable,
  type ClickArgs,
  type ScrollArgs,
  type TypeArgs
} from './desktop-control'
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

const UNAUTHORIZED_DESKTOP_IPC_ERROR = 'Unauthorized desktop IPC sender'

export function registerInputHandlers(): void {
  registerMessagePackHandler<void>(DESKTOP_INPUT_STATUS, (_args, event) => {
    if (!isTrustedDesktopIpcSender(event)) {
      return { available: false, error: UNAUTHORIZED_DESKTOP_IPC_ERROR }
    }
    return isDesktopInputAvailable()
  })

  registerMessagePackHandler<ClickArgs>(DESKTOP_INPUT_CLICK, (args, event) => {
    if (!isTrustedDesktopIpcSender(event)) {
      return { success: false, error: UNAUTHORIZED_DESKTOP_IPC_ERROR }
    }
    return desktopInputClick(args)
  })

  registerMessagePackHandler<TypeArgs>(DESKTOP_INPUT_TYPE, (args, event) => {
    if (!isTrustedDesktopIpcSender(event)) {
      return { success: false, error: UNAUTHORIZED_DESKTOP_IPC_ERROR }
    }
    return desktopInputType(args)
  })

  registerMessagePackHandler<ScrollArgs>(DESKTOP_INPUT_SCROLL, (args, event) => {
    if (!isTrustedDesktopIpcSender(event)) {
      return { success: false, error: UNAUTHORIZED_DESKTOP_IPC_ERROR }
    }
    return desktopInputScroll(args)
  })
}
