import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../src/main/renderer-security', () => ({
  assertTrustedRendererIpcEvent: () => undefined,
  isTrustedRendererIpcEvent: () => true,
  registerTrustedRendererUrl: () => undefined
}))
import { decode, encode } from '@msgpack/msgpack'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>(),
  root: '',
  bundled: ''
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => {
      state.handlers.set(channel, handler)
    }
  }
}))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => state.root }
})
vi.mock('../../src/main/lib/ola-data-root', () => ({ olaDataRoot: () => join(state.root, '.ola') }))
vi.mock('../../src/main/resources/bundled-resources', () => ({
  getBundledResourceDirCandidates: (name: string) => [join(state.bundled, name)]
}))
vi.mock('../../src/main/lib/api-user-agent', () => ({ getDefaultApiUserAgent: () => 'test-agent' }))
vi.mock('../../src/main/user-content/soul-market-client', () => ({
  SoulMarketClient: class {
    async list() {
      return { total: 1, souls: [{ id: '1', slug: 'writer', name: 'Writer' }] }
    }

    async categories() {
      return [{ id: 'writing', name: 'Writing' }]
    }

    async download() {
      return '# downloaded soul'
    }
  }
}))

import { registerSoulsHandlers } from '../../src/main/ipc/souls-handlers'

async function call<T>(channel: string, args?: unknown): Promise<T> {
  const handler = state.handlers.get(`${channel}:msgpack`)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return decode(await handler({}, encode(args))) as T
}

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'ola-souls-ipc-'))
  state.bundled = await mkdtemp(join(tmpdir(), 'ola-souls-bundled-'))
  state.handlers.clear()
  registerSoulsHandlers()
})

afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
  await rm(state.bundled, { recursive: true, force: true })
})

it('owns Soul local and marketplace IPC in Main TS with MessagePack contracts', async () => {
  await expect(call('souls:builtin-list')).resolves.toMatchObject({ templates: [] })
  await expect(call('souls:market-list', { query: 'writer' })).resolves.toMatchObject({
    total: 1,
    souls: [{ slug: 'writer' }]
  })
  await expect(call('souls:categories')).resolves.toEqual({
    categories: [{ id: 'writing', name: 'Writing' }]
  })
  await expect(call('souls:download-remote', { slug: 'writer' })).resolves.toEqual({
    content: '# downloaded soul'
  })
  await expect(call('souls:get-target-paths')).resolves.toMatchObject({
    global: { path: join(state.root, '.ola', 'SOUL.md') }
  })
  await expect(call('souls:install', { content: 'Local soul' })).resolves.toMatchObject({
    success: true,
    path: join(state.root, '.ola', 'SOUL.md')
  })
})
