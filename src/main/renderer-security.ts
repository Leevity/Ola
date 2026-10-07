import { BrowserWindow, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'

const rendererUrls = new WeakMap<BrowserWindow, string>()
const configuredWindows = new WeakSet<BrowserWindow>()

function isSameRendererDocument(expectedValue: string, actualValue: string): boolean {
  try {
    const expected = new URL(expectedValue)
    const actual = new URL(actualValue)
    return (
      expected.protocol === actual.protocol &&
      expected.host === actual.host &&
      expected.pathname === actual.pathname &&
      !actual.username &&
      !actual.password
    )
  } catch {
    return false
  }
}

export function registerTrustedRendererUrl(window: BrowserWindow, url: string): void {
  rendererUrls.set(window, url)
  if (configuredWindows.has(window)) return
  configuredWindows.add(window)

  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(window, url)) return
    event.preventDefault()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch((error) => {
        console.error('[Main] Failed to open external URL:', url, error)
      })
    }
    return { action: 'deny' }
  })

  window.on('closed', () => rendererUrls.delete(window))
}

export function isTrustedRendererUrl(
  window: BrowserWindow,
  url = window.webContents.getURL()
): boolean {
  const expectedUrl = rendererUrls.get(window)
  return Boolean(
    expectedUrl &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed() &&
    isSameRendererDocument(expectedUrl, url)
  )
}

export function isTrustedRendererIpcEvent(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender)
  return Boolean(
    window &&
    !window.isDestroyed() &&
    window.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame &&
    isTrustedRendererUrl(window, event.senderFrame.url)
  )
}

export function assertTrustedRendererIpcEvent(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!isTrustedRendererIpcEvent(event)) throw new Error('UNTRUSTED_IPC_SENDER')
}
