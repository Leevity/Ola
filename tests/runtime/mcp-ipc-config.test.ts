import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../src/main/renderer-security', () => ({
  assertTrustedRendererIpcEvent: () => undefined,
  isTrustedRendererIpcEvent: () => true,
  registerTrustedRendererUrl: () => undefined
}))
import { decode, encode } from '@msgpack/msgpack'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>(),
  applied: [] as unknown[],
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
  createdAt: 1,
  toolAlias: id
})

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'ola-mcp-ipc-'))
  state.handlers.clear()
  state.applied.length = 0
  // The handler owns a module-level config store; import after the isolated
  // data root exists so the fixture cannot capture the repository directory.
  vi.resetModules()
  const { registerMcpHandlers } = await import('../../src/main/ipc/mcp-handlers')
  registerMcpHandlers({
    disconnectServer: vi.fn(async () => {}),
    connectServer: vi.fn(async () => {}),
    applyConfig: (config: unknown) => state.applied.push(config)
  } as never)
})

afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
})

it('owns MCP config CRUD in Main TS and enforces the trusted IPC sender', async () => {
  const repositoryConfig = await readFile('mcp-servers.json')
  await expect(call('mcp:list', undefined)).resolves.toEqual([])
  await expect(call('mcp:add', server('one'))).resolves.toEqual({ success: true })
  await expect(call('mcp:get', 'one')).resolves.toEqual({ server: server('one') })
  await expect(call('mcp:list', undefined)).resolves.toEqual([server('one')])
  await expect(call('mcp:update', { id: 'one', patch: { enabled: false } })).resolves.toEqual({
    success: true
  })
  await expect(call('mcp:remove', 'one')).resolves.toEqual({ success: true })
  expect(JSON.parse(await readFile(join(state.root, 'mcp-servers.json'), 'utf8'))).toEqual([])
  expect(await readFile('mcp-servers.json')).toEqual(repositoryConfig)
  const handler = state.handlers.get('mcp:list:msgpack')
  expect(handler).toBeDefined()
  await expect(handler!({ sender: {}, senderFrame: {} }, encode(undefined))).rejects.toThrow(
    'Unauthorized MCP IPC sender'
  )
})

it('freezes the tool alias, rejects an over-budget allowlist, and reports preflight', async () => {
  await call('mcp:add', { ...server('one'), name: 'One' })
  // The alias is Main's, not the client's: a patch can rename the display label but never move
  // the namespace the model already uses.
  await expect(
    call('mcp:update', { id: 'one', patch: { toolAlias: 'evil', name: 'Renamed' } })
  ).resolves.toEqual({ success: true })
  await expect(call('mcp:get', 'one')).resolves.toEqual({
    server: { ...server('one'), name: 'Renamed' }
  })

  const oversized = Array.from({ length: 33 }, (_value, index) => `tool_${index}`)
  await expect(
    call('mcp:update', { id: 'one', patch: { enabledTools: oversized } })
  ).resolves.toMatchObject({ success: false })
  await expect(call('mcp:get', 'one')).resolves.toEqual({
    server: { ...server('one'), name: 'Renamed' }
  })
  await expect(
    call('mcp:update', { id: 'one', patch: { enabledTools: ['tool_0', 'tool_0', 'tool_1'] } })
  ).resolves.toEqual({ success: true })
  await expect(call('mcp:get', 'one')).resolves.toEqual({
    server: { ...server('one'), name: 'Renamed', enabledTools: ['tool_0', 'tool_1'] }
  })
  // An accepted edit reaches the live connection without a reconnect; a rejected one never does.
  expect(state.applied).toHaveLength(2)
  expect(state.applied.at(-1)).toMatchObject({
    id: 'one',
    toolAlias: 'one',
    enabledTools: ['tool_0', 'tool_1']
  })

  await expect(call('mcp:preflight', 'one')).resolves.toEqual({
    success: true,
    diagnostic: null,
    blocked: false
  })
  await call('mcp:update', {
    id: 'one',
    patch: { preflight: { requiredCommands: ['ola-no-such'] } }
  })
  await expect(call('mcp:preflight', 'one')).resolves.toEqual({
    success: true,
    diagnostic: {
      code: 'COMMAND_MISSING',
      detail: 'ola-no-such',
      hint: 'Install ola-no-such and make sure it is on PATH, or choose Ignore preflight to connect without it.'
    },
    blocked: true
  })
})
