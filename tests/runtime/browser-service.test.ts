import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeContents = Record<string, unknown> & { destroy: () => void }

const hosts = new Map<number, FakeContents>()
const guests = new Map<number, FakeContents>()

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn((contents: { id: number }) => ({
      id: contents.id + 1000,
      isDestroyed: () => false
    }))
  },
  webContents: {
    fromId: vi.fn((id: number) => hosts.get(id) ?? guests.get(id) ?? null)
  }
}))

import { MainBrowserService } from '../../src/main/browser/browser-service'

function fakeContents(id: number, type: 'window' | 'webview'): FakeContents {
  const listeners = new Map<string, () => void>()
  return {
    id,
    getType: () => type,
    hostWebContents: type === 'webview' ? { id: 10 } : undefined,
    isDestroyed: () => false,
    once: (event: string, callback: () => void) => listeners.set(event, callback),
    destroy: () => listeners.get('destroyed')?.()
  }
}

describe('MainBrowserService lifecycle ownership', () => {
  beforeEach(() => {
    hosts.clear()
    guests.clear()
  })

  it('removes all tabs when the owning host window is destroyed', () => {
    const host = fakeContents(10, 'window')
    const guest = fakeContents(20, 'webview')
    hosts.set(10, host)
    guests.set(20, guest)
    const service = new MainBrowserService()

    service.registerUserTab({
      tabId: 'tab-a',
      workspaceId: 'local-personal',
      profileId: 'profile-a',
      hostWebContentsId: 10,
      guestWebContentsId: 20
    })
    service.takeUserControl({ tabId: 'tab-a', hostWebContentsId: 10 })

    host.destroy()

    expect(() => service.takeUserControl({ tabId: 'tab-a', hostWebContentsId: 10 })).toThrow(
      'BROWSER_TAB_NOT_FOUND'
    )
  })

  it('removes a single tab when its guest is destroyed', () => {
    const host = fakeContents(10, 'window')
    const guest = fakeContents(20, 'webview')
    hosts.set(10, host)
    guests.set(20, guest)
    const service = new MainBrowserService()

    service.registerUserTab({
      tabId: 'tab-a',
      workspaceId: 'local-personal',
      profileId: 'profile-a',
      hostWebContentsId: 10,
      guestWebContentsId: 20
    })
    guest.destroy()

    expect(() => service.takeUserControl({ tabId: 'tab-a', hostWebContentsId: 10 })).toThrow(
      'BROWSER_TAB_NOT_FOUND'
    )
  })
})
