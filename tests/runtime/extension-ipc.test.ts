import { beforeEach, expect, it, vi } from 'vitest'
import { decode, encode } from '@msgpack/msgpack'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>()
}))

vi.mock('electron', () => ({
  shell: { openPath: vi.fn(async () => '') },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => state.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/extensions/extension-runtime', () => ({
  getExtensionService: () => ({
    list: async () => [{ id: 'weather' }],
    getManifest: async (id: string) => {
      if (id !== 'weather') throw new Error(`Extension "${id}" not found`)
      return { id }
    },
    getPath: (id: string) => `/tmp/extensions/${id}`,
    getRuntime: async (id: string) => ({
      id,
      enabled: id === 'weather',
      manifest: { id, name: id, tools: [] },
      config: { token: 'main-only' }
    }),
    update: async (id: string) => {
      if (id !== 'weather') throw new Error(`Extension "${id}" not found`)
    }
  }),
  getExtensionPackageManager: () => ({
    installFromFolder: vi.fn(),
    remove: vi.fn()
  }),
  getExtensionStorage: () => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() })
}))
vi.mock('../../src/main/extensions/extension-http-tool', () => ({
  executeExtensionHttpTool: vi.fn(
    async (args: { toolName: string; config: Record<string, string> }) => ({
      __olaExtensionResult: true,
      toolName: args.toolName,
      configSeenByMain: args.config.token
    })
  )
}))

import { registerExtensionHandlers } from '../../src/main/ipc/extension-handlers'

async function call<T>(channel: string, args: unknown): Promise<T> {
  const handler = state.handlers.get(`${channel}:msgpack`)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return decode(await handler({}, encode(args))) as T
}

beforeEach(() => {
  state.handlers.clear()
  registerExtensionHandlers()
})

it('owns extension path resolution in Main TS and rejects missing extensions', async () => {
  await expect(call('extension:resolve-path', { id: 'weather' })).resolves.toEqual({
    success: true,
    path: '/tmp/extensions/weather'
  })
  await expect(call('extension:resolve-path', { id: 'missing' })).resolves.toMatchObject({
    success: false,
    error: expect.stringContaining('not found')
  })
  await expect(
    call('extension:execute-tool', {
      id: 'weather',
      toolName: 'lookup',
      input: { city: 'Shanghai' }
    })
  ).resolves.toEqual({
    __olaExtensionResult: true,
    toolName: 'lookup',
    configSeenByMain: 'main-only'
  })
})

it('routes extension lifecycle, assets, and storage through Main TS', async () => {
  await expect(call('extension:list', undefined)).resolves.toEqual([{ id: 'weather' }])
  await expect(
    call('extension:install-from-folder', { sourcePath: '/tmp/weather' })
  ).resolves.toEqual({
    success: true
  })
  await expect(
    call('extension:update', { id: 'weather', patch: { enabled: false } })
  ).resolves.toEqual({
    success: true
  })
  await expect(call('extension:remove', { id: 'weather' })).resolves.toEqual({ success: true })
  await expect(call('extension:open-folder', { id: 'weather' })).resolves.toEqual({ success: true })
  await expect(
    call('extension:read-asset', { id: 'missing', path: 'manifest.json' })
  ).resolves.toMatchObject({
    error: expect.stringContaining('not found')
  })
  await expect(
    call('extension:storage-get', { extensionId: 'weather', key: 'token' })
  ).resolves.toBeNull()
  await expect(
    call('extension:storage-set', { extensionId: 'weather', key: 'token', value: 'secret' })
  ).resolves.toEqual({ success: true })
  await expect(
    call('extension:storage-delete', { extensionId: 'weather', key: 'token' })
  ).resolves.toEqual({ success: true })
})
