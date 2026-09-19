import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { decodeMessagePackPayload } from '../../src/shared/messagepack/binary-ipc'

const state = vi.hoisted(() => ({
  windows: [] as unknown[],
  senderWindow: null as unknown
}))
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => state.windows,
    fromWebContents: () => state.senderWindow
  }
}))

import {
  beginWindowWorkspaceRegistration,
  getTrustedWorkspaceRegistrationWindow,
  getRegisteredWindowWorkspace,
  isWindowRegisteredForChannelTasks,
  registerWindowWorkspace,
  safeSendMessagePackToWorkspaceWindows,
  safeSendMessagePackToWorkspaceWindow
} from '../../src/main/window-ipc'

function fakeWindow(focused = false): {
  window: BrowserWindow
  received: Array<{ channel: string; payload: unknown }>
  reload: () => void
} {
  const received: Array<{ channel: string; payload: unknown }> = []
  const listeners = new Map<string, () => void>()
  const window = {
    isDestroyed: () => false,
    isFocused: () => focused,
    on: (event: string, listener: () => void) => listeners.set(event, listener),
    webContents: {
      mainFrame: {},
      isDestroyed: () => false,
      isCrashed: () => false,
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      postMessage: (channel: string, bytes: ArrayBuffer) => {
        received.push({ channel, payload: decodeMessagePackPayload(new Uint8Array(bytes)) })
      }
    }
  } as unknown as BrowserWindow
  return { window, received, reload: () => listeners.get('did-start-loading')?.() }
}

describe('Main window workspace routing', () => {
  it('accepts workspace registration only from the owning window main frame', () => {
    const target = fakeWindow()
    state.senderWindow = target.window
    const sender = target.window.webContents
    const trusted = {
      sender,
      senderFrame: sender.mainFrame
    } as IpcMainInvokeEvent
    expect(getTrustedWorkspaceRegistrationWindow(trusted)).toBe(target.window)
    expect(
      getTrustedWorkspaceRegistrationWindow({
        sender,
        senderFrame: {} as IpcMainInvokeEvent['senderFrame']
      } as IpcMainInvokeEvent)
    ).toBeNull()
    expect(
      getTrustedWorkspaceRegistrationWindow({
        sender: { mainFrame: {} },
        senderFrame: {}
      } as unknown as IpcMainInvokeEvent)
    ).toBeNull()
    state.senderWindow = null
    expect(getTrustedWorkspaceRegistrationWindow(trusted)).toBeNull()
  })

  it('sends workspace state changes to every matching registered window only', () => {
    const first = fakeWindow()
    const second = fakeWindow()
    const other = fakeWindow()
    const unregistered = fakeWindow()
    state.windows = [first.window, second.window, other.window, unregistered.window]
    for (const target of [first, second]) {
      registerWindowWorkspace(
        target.window,
        'team-a',
        beginWindowWorkspaceRegistration(target.window),
        false
      )
    }
    registerWindowWorkspace(
      other.window,
      'local-personal',
      beginWindowWorkspaceRegistration(other.window),
      true
    )
    safeSendMessagePackToWorkspaceWindows('team-a', 'goal:updated', { workspaceId: 'team-a' })
    expect(first.received).toHaveLength(1)
    expect(second.received).toHaveLength(1)
    expect(other.received).toEqual([])
    expect(unregistered.received).toEqual([])
  })

  it('sends a task only to registered matching windows and drops registrations on reload', () => {
    const local = fakeWindow()
    const team = fakeWindow()
    const unregistered = fakeWindow()
    state.windows = [local.window, team.window, unregistered.window]
    registerWindowWorkspace(
      local.window,
      'local-personal',
      beginWindowWorkspaceRegistration(local.window),
      true
    )
    registerWindowWorkspace(
      team.window,
      'team-a',
      beginWindowWorkspaceRegistration(team.window),
      true
    )
    expect(isWindowRegisteredForChannelTasks(team.window, 'team-a')).toBe(true)
    expect(isWindowRegisteredForChannelTasks(team.window, 'local-personal')).toBe(false)
    expect(getRegisteredWindowWorkspace(team.window)).toBe('team-a')
    expect(getRegisteredWindowWorkspace(unregistered.window)).toBeNull()

    expect(
      safeSendMessagePackToWorkspaceWindow('team-a', 'plugin:session-task', {
        workspaceId: 'team-a',
        content: 'private team content'
      })
    ).toBe(true)
    expect(local.received).toEqual([])
    expect(unregistered.received).toEqual([])
    expect(team.received).toEqual([
      {
        channel: 'plugin:session-task:msgpack',
        payload: { workspaceId: 'team-a', content: 'private team content' }
      }
    ])

    team.reload()
    expect(getRegisteredWindowWorkspace(team.window)).toBeNull()
    expect(isWindowRegisteredForChannelTasks(team.window, 'team-a')).toBe(false)
    expect(safeSendMessagePackToWorkspaceWindow('team-a', 'plugin:session-task', {})).toBe(false)
    registerWindowWorkspace(
      team.window,
      'local-personal',
      beginWindowWorkspaceRegistration(team.window),
      true
    )
    expect(safeSendMessagePackToWorkspaceWindow('local-personal', 'plugin:session-task', {})).toBe(
      true
    )
    expect(local.received.length + team.received.length).toBe(2)
  })

  it('does not let a stale authorization completion restore an older workspace', () => {
    const target = fakeWindow()
    state.windows = [target.window]
    const oldVersion = beginWindowWorkspaceRegistration(target.window)
    const currentVersion = beginWindowWorkspaceRegistration(target.window)
    expect(registerWindowWorkspace(target.window, 'local-personal', currentVersion, true)).toBe(
      true
    )
    expect(registerWindowWorkspace(target.window, 'team-a', oldVersion, true)).toBe(false)
    expect(safeSendMessagePackToWorkspaceWindow('team-a', 'plugin:session-task', {})).toBe(false)
    target.reload()
    expect(registerWindowWorkspace(target.window, 'team-a', currentVersion, true)).toBe(false)
    expect(safeSendMessagePackToWorkspaceWindow('local-personal', 'plugin:session-task', {})).toBe(
      false
    )
  })

  it('rejects the first registration if the window reloads while authorization is pending', () => {
    const target = fakeWindow()
    state.windows = [target.window]
    const pendingVersion = beginWindowWorkspaceRegistration(target.window)

    target.reload()

    expect(registerWindowWorkspace(target.window, 'team-a', pendingVersion, true)).toBe(false)
    expect(safeSendMessagePackToWorkspaceWindow('team-a', 'plugin:session-task', {})).toBe(false)
    expect(target.received).toEqual([])
  })

  it('chooses one focused window instead of running the same task twice', () => {
    const background = fakeWindow()
    const foreground = fakeWindow(true)
    state.windows = [background.window, foreground.window]
    registerWindowWorkspace(
      background.window,
      'team-a',
      beginWindowWorkspaceRegistration(background.window),
      true
    )
    registerWindowWorkspace(
      foreground.window,
      'team-a',
      beginWindowWorkspaceRegistration(foreground.window),
      true
    )
    expect(safeSendMessagePackToWorkspaceWindow('team-a', 'plugin:session-task', {})).toBe(true)
    expect(background.received).toEqual([])
    expect(foreground.received).toHaveLength(1)
  })

  it('skips focused detached windows that do not host the auto-reply listener', () => {
    const main = fakeWindow()
    const detached = fakeWindow(true)
    state.windows = [main.window, detached.window]
    registerWindowWorkspace(
      main.window,
      'team-a',
      beginWindowWorkspaceRegistration(main.window),
      true
    )
    registerWindowWorkspace(
      detached.window,
      'team-a',
      beginWindowWorkspaceRegistration(detached.window),
      false
    )
    expect(safeSendMessagePackToWorkspaceWindow('team-a', 'plugin:session-task', {})).toBe(true)
    expect(main.received).toHaveLength(1)
    expect(detached.received).toEqual([])
  })
})
