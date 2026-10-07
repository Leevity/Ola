import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../src/main/renderer-security', () => ({
  assertTrustedRendererIpcEvent: () => undefined,
  isTrustedRendererIpcEvent: () => true,
  registerTrustedRendererUrl: () => undefined
}))
import { decode, encode } from '@msgpack/msgpack'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>(),
  root: '',
  bundled: ''
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => state.root
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => {
      state.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../src/main/lib/ola-data-root', () => ({ olaDataRoot: () => state.root }))
vi.mock('../../src/main/resources/bundled-resources', () => ({
  getBundledResourceDirCandidates: (name: string) => [join(state.bundled, name)]
}))

import { registerCommandsHandlers } from '../../src/main/ipc/commands-handlers'
import { registerPromptsHandlers } from '../../src/main/ipc/prompts-handlers'

async function call<T>(channel: string, args?: unknown): Promise<T> {
  const handler = state.handlers.get(`${channel}:msgpack`)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return decode(await handler({}, encode(args))) as T
}

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'ola-user-content-ipc-'))
  state.bundled = await mkdtemp(join(tmpdir(), 'ola-user-content-bundled-'))
  await mkdir(join(state.bundled, 'commands'))
  await mkdir(join(state.bundled, 'prompts'))
  await writeFile(join(state.bundled, 'commands', 'review.md'), '# Review\nInspect the change.')
  await writeFile(join(state.bundled, 'prompts', 'default.md'), 'You are a careful assistant.')
  state.handlers.clear()
  registerCommandsHandlers()
  registerPromptsHandlers()
})

afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
  await rm(state.bundled, { recursive: true, force: true })
})

it('owns command catalog ensure/list/load/manage operations in Main TS', async () => {
  await expect(call('commands:ensure')).resolves.toEqual({ success: true })
  await expect(call('commands:list')).resolves.toEqual([{ name: 'review', summary: 'Review' }])
  await expect(call('commands:load', { name: 'review' })).resolves.toMatchObject({
    name: 'review',
    content: '# Review\nInspect the change.'
  })
  await expect(
    call('commands:manage-create', { name: 'daily', content: 'Do the daily check.' })
  ).resolves.toMatchObject({
    success: true
  })
  await expect(
    call('commands:manage-create', { name: '../escape', content: 'bad' })
  ).resolves.toMatchObject({
    success: false
  })
  await expect(
    call('commands:manage-save', { path: join(state.root, 'outside.md'), content: 'bad' })
  ).resolves.toMatchObject({
    success: false
  })
})

it('owns prompt ensure/list/load operations in Main TS', async () => {
  await expect(call('prompts:ensure')).resolves.toEqual({ success: true })
  await expect(call('prompts:list')).resolves.toEqual(['default'])
  await expect(call('prompts:load', { name: 'default' })).resolves.toEqual({
    content: 'You are a careful assistant.'
  })
  await expect(call('prompts:load', { name: '../missing' })).resolves.toMatchObject({
    error: expect.any(String)
  })
})
