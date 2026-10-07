import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeContents = Record<string, unknown> & { destroy: () => void }

const hosts = new Map<number, FakeContents>()
const guests = new Map<number, FakeContents>()
const browserConfig = vi.hoisted(() => ({ value: undefined as unknown }))

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
vi.mock('../../src/main/ipc/secure-key-store', () => ({
  getConfigValue: vi.fn(async () => browserConfig.value)
}))

import { MainBrowserService } from '../../src/main/browser/browser-service'

function fakeContents(id: number, type: 'window' | 'webview'): FakeContents {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const loads: string[] = []
  return {
    id,
    getType: () => type,
    hostWebContents: type === 'webview' ? { id: 10 } : undefined,
    isDestroyed: () => false,
    once: (event: string, callback: () => void) => listeners.set(event, callback),
    on: (event: string, callback: (...args: unknown[]) => void) =>
      listeners.set(`on:${event}`, callback),
    loadURL: async (url: string) => {
      loads.push(url)
    },
    loads,
    emit: (event: string, ...args: unknown[]) => listeners.get(`on:${event}`)?.(...args),
    destroy: () => listeners.get('destroyed')?.()
  }
}

describe('MainBrowserService lifecycle ownership', () => {
  beforeEach(() => {
    hosts.clear()
    guests.clear()
    browserConfig.value = undefined
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

  it('resolves exactly one tab by workspace and session identity', () => {
    const host = fakeContents(10, 'window')
    const guest = fakeContents(20, 'webview')
    hosts.set(10, host)
    guests.set(20, guest)
    const service = new MainBrowserService()
    service.registerUserTab({
      tabId: 'tab-session-a',
      workspaceId: 'workspace-a',
      profileId: 'profile-a',
      hostWebContentsId: 10,
      guestWebContentsId: 20,
      sessionId: 'session-a',
      projectId: 'project-a'
    })

    expect(
      service.findUserTab({ workspaceId: 'workspace-a', sessionId: 'session-a' })
    ).toMatchObject({
      ownership: { workspaceId: 'workspace-a' },
      sessionId: 'session-a',
      projectId: 'project-a'
    })
    expect(() =>
      service.findUserTab({ workspaceId: 'workspace-b', sessionId: 'session-a' })
    ).toThrow('BROWSER_TAB_NOT_FOUND')
  })

  it('does not guess when a session has multiple registered browser tabs', () => {
    const host = fakeContents(10, 'window')
    const guestA = fakeContents(20, 'webview')
    const guestB = fakeContents(21, 'webview')
    hosts.set(10, host)
    guests.set(20, guestA)
    guests.set(21, guestB)
    const service = new MainBrowserService()
    for (const [tabId, guestWebContentsId] of [
      ['tab-a', 20],
      ['tab-b', 21]
    ] as const) {
      service.registerUserTab({
        tabId,
        workspaceId: 'workspace-a',
        profileId: 'profile-a',
        hostWebContentsId: 10,
        guestWebContentsId,
        sessionId: 'session-a'
      })
    }
    expect(() =>
      service.findUserTab({ workspaceId: 'workspace-a', sessionId: 'session-a' })
    ).toThrow('BROWSER_TAB_AMBIGUOUS')
  })

  it('blocks page-originated navigation to a disallowed domain while a run owns the tab', async () => {
    browserConfig.value = {
      state: {
        pluginsByProject: {
          __global__: [{ id: 'browser', enabled: true, browserBlockedDomains: ['blocked.example'] }]
        }
      }
    }
    const host = fakeContents(10, 'window')
    const guest = fakeContents(20, 'webview')
    hosts.set(10, host)
    guests.set(20, guest)
    const service = new MainBrowserService()
    service.registerUserTab({
      tabId: 'tab-policy',
      workspaceId: 'local-personal',
      profileId: 'profile-a',
      hostWebContentsId: 10,
      guestWebContentsId: 20,
      sessionId: 'session-a'
    })
    service.takeRunControl({ tabId: 'tab-policy', hostWebContentsId: 10, runId: 'run-a' })
    const preventDefault = vi.fn()
    ;(guest.emit as (event: string, ...args: unknown[]) => void)(
      'will-navigate',
      { preventDefault },
      'https://blocked.example/private'
    )
    expect(preventDefault).toHaveBeenCalledOnce()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(guest.loads).toEqual([])
  })
})
