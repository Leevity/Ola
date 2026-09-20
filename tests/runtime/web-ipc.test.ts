import { beforeEach, expect, it, vi } from 'vitest'
import { decode, encode } from '@msgpack/msgpack'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => state.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/web/web-search-secret-store', () => ({
  getWebSearchSecretStore: () => ({
    status: async () => ({ configured: false }),
    set: async () => ({ success: true }),
    delete: async () => ({ success: true })
  })
}))
vi.mock('../../src/main/web/web-search-secret-resolution', () => ({
  migrateLegacyWebSearchSecret: async () => {},
  resolveWebSearchSecret: async () => undefined
}))
vi.mock('../../src/main/ipc/settings-handlers', () => ({
  clearLegacyWebSearchApiKey: async () => {},
  readLegacyWebSearchApiKey: async () => ''
}))

import { registerWebSearchHandlers } from '../../src/main/ipc/web-search-handlers'

async function call<T>(channel: string, args: unknown): Promise<T> {
  const handler = state.handlers.get(`${channel}:msgpack`)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return decode(await handler({}, encode(args))) as T
}

beforeEach(() => {
  state.handlers.clear()
  registerWebSearchHandlers()
})

it('owns web search/fetch IPC in Main TS with offline-safe branches', async () => {
  await expect(call('web:search-config', undefined)).resolves.toMatchObject({
    providers: expect.arrayContaining(['exa-mcp'])
  })
  await expect(call('web:search-providers', undefined)).resolves.toContain('tavily')
  await expect(
    call('web:search', { query: 'offline', provider: 'exa-mcp' })
  ).resolves.toMatchObject({ provider: 'exa-mcp', totalResults: 0 })
  await expect(call('web:fetch', {})).resolves.toMatchObject({
    error: 'Web fetch requires a url or urls input'
  })
  await expect(call('web:search-secret-status', undefined)).resolves.toEqual({ configured: false })
})
