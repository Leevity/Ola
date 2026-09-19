import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { encodeMessagePackPayload, toMessagePackChannel } from '../shared/messagepack/binary-ipc'

const windowWorkspaces = new WeakMap<
  BrowserWindow,
  { workspaceId: string; acceptsChannelTasks: boolean }
>()
const workspaceRegistrationVersions = new WeakMap<BrowserWindow, number>()
const workspaceLifecycleBound = new WeakSet<BrowserWindow>()

export function getTrustedWorkspaceRegistrationWindow(
  event: IpcMainInvokeEvent
): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (
    !win ||
    win.isDestroyed() ||
    win.webContents.isDestroyed() ||
    win.webContents !== event.sender ||
    event.senderFrame !== event.sender.mainFrame
  )
    return null
  return win
}

function invalidateWindowWorkspace(win: BrowserWindow): number {
  const version = (workspaceRegistrationVersions.get(win) ?? 0) + 1
  workspaceRegistrationVersions.set(win, version)
  windowWorkspaces.delete(win)
  return version
}

function bindWindowWorkspaceLifecycle(win: BrowserWindow): void {
  if (workspaceLifecycleBound.has(win)) return
  workspaceLifecycleBound.add(win)
  win.webContents.on('did-start-loading', () => invalidateWindowWorkspace(win))
  win.on('closed', () => invalidateWindowWorkspace(win))
}

export function beginWindowWorkspaceRegistration(win: BrowserWindow): number {
  if (win.isDestroyed() || win.webContents.isDestroyed())
    throw new Error('WINDOW_WORKSPACE_UNAVAILABLE')
  bindWindowWorkspaceLifecycle(win)
  return invalidateWindowWorkspace(win)
}

export function registerWindowWorkspace(
  win: BrowserWindow,
  workspaceId: string,
  version: number,
  acceptsChannelTasks: boolean
): boolean {
  if (workspaceRegistrationVersions.get(win) !== version) return false
  if (win.isDestroyed() || win.webContents.isDestroyed()) return false
  windowWorkspaces.set(win, { workspaceId, acceptsChannelTasks })
  return true
}

export function isWindowRegisteredForChannelTasks(
  win: BrowserWindow,
  workspaceId: string
): boolean {
  const registration = windowWorkspaces.get(win)
  return (
    !win.isDestroyed() &&
    !win.webContents.isDestroyed() &&
    registration?.workspaceId === workspaceId &&
    registration.acceptsChannelTasks
  )
}

export function getRegisteredWindowWorkspace(win: BrowserWindow): string | null {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return null
  return windowWorkspaces.get(win)?.workspaceId ?? null
}

function isDisposedFrameError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /render frame was disposed before webframemain could be accessed/i.test(error.message)
  )
}

export function safePostMessageToWindow(
  win: BrowserWindow,
  channel: string,
  bytes: Uint8Array | Buffer
): boolean {
  if (win.isDestroyed()) {
    return false
  }

  const contents = win.webContents
  if (!contents || contents.isDestroyed() || contents.isCrashed()) {
    return false
  }

  try {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    contents.postMessage(channel, arrayBuffer)
    return true
  } catch (error) {
    if (!isDisposedFrameError(error)) {
      console.warn(`[Window IPC] Failed to post ${channel}:`, error)
    }
  }

  try {
    contents.send(channel, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    return true
  } catch (error) {
    if (!isDisposedFrameError(error)) {
      console.warn(`[Window IPC] Failed to send binary fallback ${channel}:`, error)
    }
    return false
  }
}

export function safeSendMessagePackToWindow(
  win: BrowserWindow,
  channel: string,
  payload: unknown
): boolean {
  return safePostMessageToWindow(
    win,
    toMessagePackChannel(channel),
    encodeMessagePackPayload(payload)
  )
}

export function safeSendMessagePackToAllWindows(channel: string, payload: unknown): void {
  const bytes = encodeMessagePackPayload(payload)
  const binaryChannel = toMessagePackChannel(channel)
  for (const win of BrowserWindow.getAllWindows()) {
    safePostMessageToWindow(win, binaryChannel, bytes)
  }
}

export function safeSendMessagePackToWorkspaceWindows(
  workspaceId: string,
  channel: string,
  payload: unknown
): void {
  const bytes = encodeMessagePackPayload(payload)
  const binaryChannel = toMessagePackChannel(channel)
  for (const win of BrowserWindow.getAllWindows()) {
    if (getRegisteredWindowWorkspace(win) === workspaceId) {
      safePostMessageToWindow(win, binaryChannel, bytes)
    }
  }
}

export function safeSendMessagePackToWorkspaceWindow(
  workspaceId: string,
  channel: string,
  payload: unknown
): boolean {
  const bytes = encodeMessagePackPayload(payload)
  const binaryChannel = toMessagePackChannel(channel)
  const candidates = BrowserWindow.getAllWindows()
    .filter((win) => {
      return isWindowRegisteredForChannelTasks(win, workspaceId)
    })
    .sort((left, right) => Number(right.isFocused()) - Number(left.isFocused()))
  for (const win of candidates) {
    if (safePostMessageToWindow(win, binaryChannel, bytes)) return true
  }
  return false
}
