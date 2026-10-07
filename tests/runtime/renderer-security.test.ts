import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  openExternal: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
  shell: { openExternal: electronMock.openExternal }
}))

import {
  assertTrustedRendererIpcEvent,
  isTrustedRendererIpcEvent,
  registerTrustedRendererUrl
} from '../../src/main/renderer-security'

describe('renderer document security boundary', () => {
  beforeEach(() => {
    electronMock.fromWebContents.mockReset()
    electronMock.openExternal.mockReset()
  })

  it('blocks external navigation and opens external windows in the system browser', () => {
    const listeners = new Map<
      string,
      (event: { preventDefault: () => void }, url: string) => void
    >()
    const windowOpenHandler = vi.fn()
    const webContents = {
      isDestroyed: () => false,
      on: (name: string, handler: (event: { preventDefault: () => void }, url: string) => void) =>
        listeners.set(name, handler),
      setWindowOpenHandler: windowOpenHandler,
      getURL: () => 'app://ola/index.html'
    }
    const window = {
      webContents,
      isDestroyed: () => false,
      on: vi.fn()
    }
    registerTrustedRendererUrl(window as never, 'app://ola/index.html')

    const preventDefault = vi.fn()
    listeners.get('will-navigate')?.({ preventDefault }, 'https://example.com')
    expect(preventDefault).toHaveBeenCalledOnce()
    const handler = windowOpenHandler.mock.calls[0]?.[0] as (args: { url: string }) => unknown
    expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(electronMock.openExternal).toHaveBeenCalledWith('https://example.com')
    expect(handler({ url: 'file:///tmp/evil.html' })).toEqual({ action: 'deny' })
  })

  it('accepts IPC only from the registered top-level renderer document', () => {
    const sender = {
      isDestroyed: () => false,
      getURL: () => 'app://ola/index.html',
      mainFrame: { url: 'app://ola/index.html#/settings' },
      on: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
    const window = {
      webContents: sender,
      isDestroyed: () => false,
      on: vi.fn()
    }
    const event = {
      sender: window.webContents,
      senderFrame: sender.mainFrame
    }
    electronMock.fromWebContents.mockReturnValue(window)
    registerTrustedRendererUrl(window as never, 'app://ola/index.html')
    expect(isTrustedRendererIpcEvent(event as never)).toBe(true)
    expect(() => assertTrustedRendererIpcEvent(event as never)).not.toThrow()
    expect(
      isTrustedRendererIpcEvent({
        ...event,
        senderFrame: { url: 'https://example.com', isMainFrame: true }
      } as never)
    ).toBe(false)
    expect(
      isTrustedRendererIpcEvent({
        ...event,
        senderFrame: { url: 'app://ola/index.html', isMainFrame: false }
      } as never)
    ).toBe(false)
  })
})
