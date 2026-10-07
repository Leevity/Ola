import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../src/main/renderer-security', () => ({
  assertTrustedRendererIpcEvent: () => undefined,
  isTrustedRendererIpcEvent: () => true,
  registerTrustedRendererUrl: () => undefined
}))
import { decode, encode } from '@msgpack/msgpack'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>(),
  sender: { mainFrame: {}, isDestroyed: () => false }
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'desktop' ? '/tmp' : '/tmp') },
  BrowserWindow: {
    fromWebContents: (sender: unknown) => ({ webContents: sender, isDestroyed: () => false }),
    getAllWindows: () => []
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true })
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => state.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/ipc/agent-change-handlers', () => ({
  recordLocalTextWriteChange: async () => {}
}))
vi.mock('../../src/main/window-ipc', () => ({ safeSendMessagePackToWindow: vi.fn() }))

import { registerFsHandlers } from '../../src/main/ipc/fs-handlers'

let root = ''
const event = { sender: state.sender, senderFrame: state.sender.mainFrame }

async function call<T>(channel: string, args: unknown): Promise<T> {
  const handler = state.handlers.get(`${channel}:msgpack`)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return decode(await handler(event, encode(args))) as T
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ola-fs-ipc-'))
  await writeFile(join(root, 'note.txt'), 'alpha\nbeta\n')
  await writeFile(join(root, 'other.md'), '# alpha\n')
  state.handlers.clear()
  registerFsHandlers()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('routes local file operations and search through the Main TS filesystem service', async () => {
  await expect(call('fs:read-file', { path: join(root, 'note.txt') })).resolves.toContain('alpha')
  await expect(
    call('fs:read-text-file-lines', { path: join(root, 'note.txt'), maxLines: 1 })
  ).resolves.toMatchObject({ content: 'alpha', truncated: true })
  await expect(call('fs:stat-path', { path: join(root, 'note.txt') })).resolves.toMatchObject({
    exists: true,
    type: 'file'
  })
  await expect(call('fs:list-dir', { path: root })).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'note.txt' })])
  )
  await expect(call('fs:mkdir', { path: join(root, 'nested') })).resolves.toEqual({ success: true })
  await expect(
    call('fs:write-file', { path: join(root, 'nested', 'new.txt'), content: 'created' })
  ).resolves.toMatchObject({ success: true })
  await expect(
    call('fs:read-file-binary', { path: join(root, 'nested', 'new.txt') })
  ).resolves.toMatchObject({
    data: expect.any(String)
  })
  await expect(
    call('fs:write-file-binary', { path: join(root, 'nested', 'binary.bin'), data: 'AQI=' })
  ).resolves.toEqual({ success: true })
  await expect(readFile(join(root, 'nested', 'binary.bin'))).resolves.toEqual(Buffer.from([1, 2]))
  await expect(call('fs:glob', { path: root, pattern: '**/*.txt' })).resolves.toMatchObject({
    kind: 'glob',
    matches: expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining('note.txt') })
    ])
  })
  await expect(call('fs:search-files', { path: root, query: 'note' })).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining('note.txt') })])
  )
  await expect(call('fs:grep', { path: root, pattern: 'alpha' })).resolves.toMatchObject({
    kind: 'grep',
    matches: expect.any(Array)
  })
  await expect(call('fs:read-document', { path: join(root, 'other.md') })).resolves.toBeDefined()
  await expect(
    call('fs:move', { from: join(root, 'nested', 'new.txt'), to: join(root, 'moved.txt') })
  ).resolves.toEqual({
    success: true
  })
  await expect(call('fs:delete', { path: join(root, 'moved.txt') })).resolves.toEqual({
    success: true
  })
  const unauthorized = state.handlers.get('fs:read-file:msgpack')
  expect(
    decode(
      await unauthorized!({ sender: {}, senderFrame: {} }, encode({ path: join(root, 'note.txt') }))
    )
  ).toMatchObject({ error: expect.stringContaining('Unauthorized') })
})
