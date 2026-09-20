import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decode, encode } from '@msgpack/msgpack'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>(),
  root: ''
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (sender: unknown) => ({ webContents: sender, isDestroyed: () => false })
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => state.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/lib/ola-data-root', () => ({ olaDataRoot: () => state.root }))
vi.mock('../../src/main/mcp/autoconnect-coordinator', () => ({
  McpAutoConnectCoordinator: class {
    reset() {
      return undefined
    }
    async connectEnabled() {
      return []
    }
  }
}))
vi.mock('../../src/main/mcp/mcp-manager', () => ({ McpManager: class {} }))

import { registerMcpHandlers } from '../../src/main/ipc/mcp-handlers'

const sender = { mainFrame: {}, isDestroyed: () => false }
const event = { sender, senderFrame: sender.mainFrame }

async function call<T>(channel: string, args: unknown): Promise<T> {
  const handler = state.handlers.get(`${channel}:msgpack`)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return decode(await handler(event, encode(args))) as T
}

const server = (id: string) => ({
  id,
  name: id,
  enabled: true,
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  createdAt: 1
})

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'ola-mcp-ipc-'))
  state.handlers.clear()
  registerMcpHandlers({
    disconnectServer: vi.fn(async () => {}),
    connectServer: vi.fn(async () => {})
  } as never)
})

afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
})

it('owns MCP config CRUD in Main TS and enforces the trusted IPC sender', async () => {
  await expect(call('mcp:list', undefined)).resolves.toEqual([])
  await expect(call('mcp:add', server('one'))).resolves.toEqual({ success: true })
  await expect(call('mcp:get', 'one')).resolves.toEqual({ server: server('one') })
  await expect(call('mcp:list', undefined)).resolves.toEqual([server('one')])
  await expect(call('mcp:update', { id: 'one', patch: { enabled: false } })).resolves.toEqual({
    success: true
  })
  await expect(call('mcp:remove', 'one')).resolves.toEqual({ success: true })
  const handler = state.handlers.get('mcp:list:msgpack')
  expect(handler).toBeDefined()
  await expect(handler!({ sender: {}, senderFrame: {} }, encode(undefined))).rejects.toThrow(
    'Unauthorized MCP IPC sender'
  )
})
