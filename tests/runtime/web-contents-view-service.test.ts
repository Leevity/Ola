import { beforeEach, describe, expect, it, vi } from 'vitest'

const hosts = new Map<number, Record<string, unknown>>()

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
      isDestroyed: () => false,
      once: vi.fn(),
      close: vi.fn(),
      loadURL: vi.fn(async () => undefined)
    }
    setBounds = vi.fn()
  },
  webContents: {
    fromId: vi.fn((id: number) => hosts.get(id) ?? null)
  }
}))

import { WebContentsViewBrowserService } from '../../src/main/browser/web-contents-view-service'

describe('WebContentsViewBrowserService', () => {
  beforeEach(() => hosts.clear())

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
    await service.navigate('view-a', 10, 'https://example.com')
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
    await expect(service.navigate('view-b', 10, 'file:///tmp/x')).rejects.toThrow(
      'BROWSER_URL_INVALID'
    )
  })
})
