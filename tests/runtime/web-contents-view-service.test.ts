import { beforeEach, describe, expect, it, vi } from 'vitest'

const hosts = new Map<number, Record<string, unknown>>()
const viewEvents = new Map<string, (...args: unknown[]) => void>()

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn((contents: { id: number }) => ({
      id: contents.id + 1000,
      isDestroyed: () => false,
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn()
      }
    }))
  },
  WebContentsView: class {
    webContents = {
      id: 100,
      isDestroyed: () => false,
      once: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        viewEvents.set(event, listener)
      }),
      setWindowOpenHandler: vi.fn(),
      close: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      getURL: vi.fn(() => 'https://example.com/'),
      getTitle: vi.fn(() => 'Example'),
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn(),
      reload: vi.fn(),
      stop: vi.fn()
    }
    setBounds = vi.fn()
  },
  webContents: {
    fromId: vi.fn((id: number) => hosts.get(id) ?? null)
  }
}))

import { WebContentsViewBrowserService } from '../../src/main/browser/web-contents-view-service'

describe('WebContentsViewBrowserService', () => {
  beforeEach(() => {
    hosts.clear()
    viewEvents.clear()
  })

  it('creates an owned view and navigates only through its host', async () => {
    const host = { id: 10, once: vi.fn() }
    hosts.set(10, host)
    const service = new WebContentsViewBrowserService()
    const tab = service.createTab({
      tabId: 'view-a',
      workspaceId: 'local-personal',
      profileId: 'profile-a',
      hostWebContentsId: 10,
      bounds: { x: 0, y: 0, width: 800, height: 600 }
    })

    expect(tab.ownership.controller).toBeNull()
    const events: unknown[] = []
    service.onNavigationEvent((event) => events.push(event))
    viewEvents.get('did-navigate')?.()
    expect(events).toMatchObject([{ tabId: 'view-a', type: 'did-navigate' }])
    const preventDefault = vi.fn()
    viewEvents.get('will-navigate')?.({ preventDefault }, 'file:///tmp/blocked')
    expect(preventDefault).toHaveBeenCalledOnce()
    await service.navigate('view-a', 10, 'goto', 'https://example.com')
    expect(() => service.setBounds('view-a', 11, { x: 0, y: 0, width: 1, height: 1 })).toThrow(
      'BROWSER_TAB_NOT_FOUND'
    )
  })

  it('rejects non-http navigation', async () => {
    hosts.set(10, { id: 10, once: vi.fn() })
    const service = new WebContentsViewBrowserService()
    service.createTab({
      tabId: 'view-b',
      workspaceId: 'local-personal',
      profileId: 'profile-b',
      hostWebContentsId: 10,
      bounds: { x: 0, y: 0, width: 100, height: 100 }
    })
    await expect(service.navigate('view-b', 10, 'goto', 'file:///tmp/x')).rejects.toThrow(
      'BROWSER_URL_INVALID'
    )
  })

  it('does not allow another host to destroy the view', () => {
    hosts.set(10, { id: 10, once: vi.fn() })
    const service = new WebContentsViewBrowserService()
    service.createTab({
      tabId: 'view-c',
      workspaceId: 'local-personal',
      profileId: 'profile-c',
      hostWebContentsId: 10,
      bounds: { x: 0, y: 0, width: 100, height: 100 }
    })
    expect(() => service.destroyTab('view-c', 11)).toThrow('BROWSER_TAB_NOT_FOUND')
    expect(service.destroyTab('view-c', 10)).toBe(true)
  })
})
