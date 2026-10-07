import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decode, encode } from '@msgpack/msgpack'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    ) => state.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/renderer-security', () => ({
  isTrustedRendererIpcEvent: () => true,
  assertTrustedRendererIpcEvent: () => undefined,
  registerTrustedRendererUrl: () => undefined
}))
vi.mock('../../src/main/lib/ola-data-root', () => ({ olaDataRoot: () => state.root }))
vi.mock('../../src/main/resources/bundled-resources', () => ({
  getBundledResourceDirCandidates: (name: string) => [join(state.bundled, name)]
}))

import { registerAgentsHandlers } from '../../src/main/ipc/agents-handlers'

async function call<T>(channel: string, args?: unknown): Promise<T> {
  const handler = state.handlers.get(`${channel}:msgpack`)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return decode(await handler({}, encode(args))) as T
}

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'ola-agents-ipc-'))
  state.bundled = await mkdtemp(join(tmpdir(), 'ola-agents-bundled-'))
  await mkdir(join(state.bundled, 'agents'), { recursive: true })
  await writeFile(
    join(state.bundled, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews code\ntools: [Read, Grep]\n---\nReview carefully.\n',
    'utf8'
  )
  state.handlers.clear()
  registerAgentsHandlers()
})

afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
  await rm(state.bundled, { recursive: true, force: true })
})

it('owns agent catalog IPC in Main TS with filesystem and path-safety contracts', async () => {
  await expect(call('agents:list')).resolves.toEqual([
    expect.objectContaining({ name: 'reviewer', description: 'Reviews code' })
  ])
  await expect(call('agents:load', { name: 'reviewer' })).resolves.toMatchObject({
    name: 'reviewer',
    systemPrompt: expect.stringContaining('Review carefully.')
  })
  const managed = await call<Array<{ path: string }>>('agents:manage-list')
  expect(managed).toHaveLength(1)
  await expect(call('agents:manage-read', { path: managed[0].path })).resolves.toMatchObject({
    name: 'reviewer',
    content: expect.stringContaining('Review carefully.')
  })
  await expect(
    call('agents:manage-save', {
      path: managed[0].path,
      content: '---\nname: reviewer\ndescription: Updated\n---\nUpdated.\n'
    })
  ).resolves.toEqual({ success: true })
  await expect(readFile(managed[0].path, 'utf8')).resolves.toContain('Updated.')
  await expect(
    call('agents:manage-read', { path: join(state.root, '..', 'outside.md') })
  ).resolves.toMatchObject({ error: expect.any(String) })
})
