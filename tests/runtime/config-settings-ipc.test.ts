import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decode, encode } from '@msgpack/msgpack'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>(),
  root: '/tmp/ola-config-settings-ipc-fixture'
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => state.root },
  session: { defaultSession: { setProxy: vi.fn(async () => undefined) } },
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

import { registerConfigHandlers } from '../../src/main/ipc/secure-key-store'
import { registerSettingsHandlers } from '../../src/main/ipc/settings-handlers'

async function call<T>(channel: string, args?: unknown): Promise<T> {
  const handler = state.handlers.get(`${channel}:msgpack`)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return decode(await handler({}, encode(args))) as T
}

beforeEach(async () => {
  await rm(state.root, { recursive: true, force: true })
  await mkdir(state.root, { recursive: true })
  state.handlers.clear()
  registerConfigHandlers()
  registerSettingsHandlers()
})

afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
})

it('exposes the complete TS config root and key mutation contract', async () => {
  await expect(call('config:write', { theme: 'dark', removeMe: true })).resolves.toEqual({
    success: true
  })
  await expect(call('config:read')).resolves.toMatchObject({ theme: 'dark', removeMe: true })
  await expect(call('config:get', 'theme')).resolves.toBe('dark')
  await expect(call('config:delete', { key: 'removeMe' })).resolves.toEqual({ success: true })
  await expect(call('config:get', 'removeMe')).resolves.toBeNull()
  await expect(call('config:set', { key: '', value: 'invalid' })).resolves.toMatchObject({
    success: false
  })
})

it('exposes the complete TS settings root and key mutation contract', async () => {
  await expect(call('settings:write', { density: 'compact', removeMe: true })).resolves.toEqual({
    success: true
  })
  await expect(call('settings:read')).resolves.toMatchObject({ density: 'compact', removeMe: true })
  await expect(call('settings:get', 'density')).resolves.toBe('compact')
  await expect(call('settings:delete', { key: 'removeMe' })).resolves.toEqual({ success: true })
  await expect(call('settings:get', 'removeMe')).resolves.toBeNull()
  await expect(call('settings:set', { key: '', value: 'invalid' })).rejects.toThrow(
    'Missing settings key'
  )
  await expect(readFile(join(state.root, 'settings.json'), 'utf8')).resolves.toContain('density')
})
