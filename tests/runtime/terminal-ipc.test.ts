import { beforeEach, expect, it, vi } from 'vitest'
import { decode, encode } from '@msgpack/msgpack'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>(),
  sender: { mainFrame: {}, isDestroyed: () => false }
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (sender: unknown) => ({
      id: 7,
      webContents: sender,
      isDestroyed: () => false
    }),
    getAllWindows: () => []
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => state.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/window-ipc', () => ({
  getRegisteredWindowWorkspace: () => 'team-a',
  getTrustedWorkspaceRegistrationWindow: () => ({ webContents: state.sender }),
  safeSendMessagePackToWindow: vi.fn()
}))
vi.mock('../../src/main/terminal/terminal-session-manager', () => ({
  TerminalSessionManager: class {
    private readonly session = {
      id: 'terminal-1',
      workspaceId: 'team-a',
      shell: '/bin/zsh',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      createdAt: 1,
      title: 'Terminal'
    }
    onOutput() {
      return undefined
    }
    onExit() {
      return undefined
    }
    create() {
      return this.session
    }
    list() {
      return [this.session]
    }
    get() {
      return this.session
    }
    input() {
      return { success: true }
    }
    resize() {
      return { success: true }
    }
    kill() {
      return { success: true }
    }
    killAll() {
      return undefined
    }
  }
}))

import {
  killAllTerminalSessions,
  registerTerminalHandlers
} from '../../src/main/ipc/terminal-handlers'

const event = { sender: state.sender, senderFrame: state.sender.mainFrame }

async function call<T>(channel: string, args: unknown): Promise<T> {
  const handler = state.handlers.get(`${channel}:msgpack`)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return decode(await handler(event, encode(args))) as T
}

beforeEach(() => {
  state.handlers.clear()
  registerTerminalHandlers()
})

it('routes terminal lifecycle through Main TS with workspace authorization', async () => {
  await expect(
    call('terminal:create', { workspaceId: 'team-a', cwd: '/tmp', cols: 80, rows: 24 })
  ).resolves.toMatchObject({ id: 'terminal-1', workspaceId: 'team-a' })
  await expect(call('terminal:list', { workspaceId: 'team-a' })).resolves.toHaveLength(1)
  await expect(call('terminal:get', { id: 'terminal-1' })).resolves.toMatchObject({
    success: true,
    session: { workspaceId: 'team-a' }
  })
  await expect(call('terminal:input', { id: 'terminal-1', data: 'echo ok\n' })).resolves.toEqual({
    success: true
  })
  await expect(call('terminal:resize', { id: 'terminal-1', cols: 100, rows: 30 })).resolves.toEqual(
    {
      success: true
    }
  )
  await expect(call('terminal:kill', { id: 'terminal-1' })).resolves.toEqual({ success: true })
  await expect(call('terminal:create', { workspaceId: 'local-personal' })).resolves.toEqual({
    error: 'WINDOW_WORKSPACE_MISMATCH'
  })
  expect(() => killAllTerminalSessions()).not.toThrow()
})
