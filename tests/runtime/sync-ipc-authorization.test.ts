import { beforeEach, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

const state = vi.hoisted(() => {
  const sender = { mainFrame: {} }
  const window = { isDestroyed: () => false, webContents: sender }
  return { sender, window, registeredWorkspaceId: 'local-personal', allowed: new Set(['team-a']) }
})

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (sender: unknown) => (sender === state.sender ? state.window : null)
  }
}))
vi.mock('../../src/main/window-ipc', () => ({
  getRegisteredWindowWorkspace: () => state.registeredWorkspaceId
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => state.allowed
}))

import {
  assertLegacySyncIpcOwner,
  assertWorkspaceSyncIpcOwner
} from '../../src/main/sync/sync-ipc-authorization'

function event(sender: unknown = state.sender, senderFrame: unknown = state.sender.mainFrame) {
  return { sender, senderFrame } as IpcMainInvokeEvent
}

beforeEach(() => {
  state.registeredWorkspaceId = 'local-personal'
  state.allowed = new Set(['team-a'])
})

it('accepts the registered local-personal main frame', () => {
  expect(() => assertLegacySyncIpcOwner(event())).not.toThrow()
})

it('rejects team windows and untrusted frames before legacy sync access', () => {
  state.registeredWorkspaceId = 'team-a'
  expect(() => assertLegacySyncIpcOwner(event())).toThrow('SYNC_WORKSPACE_UNAVAILABLE')
  state.registeredWorkspaceId = 'local-personal'
  expect(() => assertLegacySyncIpcOwner(event({}, {}))).toThrow('SYNC_WORKSPACE_UNAVAILABLE')
  expect(() => assertLegacySyncIpcOwner(event(state.sender, {}))).toThrow(
    'SYNC_WORKSPACE_UNAVAILABLE'
  )
})

it('allows only an authorized registered workspace for v2 sync', async () => {
  state.registeredWorkspaceId = 'team-a'
  await expect(assertWorkspaceSyncIpcOwner(event(), 'team-a')).resolves.toBeUndefined()
  await expect(assertWorkspaceSyncIpcOwner(event(), 'local-personal')).rejects.toThrow(
    'SYNC_WORKSPACE_UNAVAILABLE'
  )
  state.allowed = new Set()
  await expect(assertWorkspaceSyncIpcOwner(event(), 'team-a')).rejects.toThrow(
    'SYNC_WORKSPACE_UNAVAILABLE'
  )
})
