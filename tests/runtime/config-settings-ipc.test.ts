import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../src/main/renderer-security', () => ({
  assertTrustedRendererIpcEvent: () => undefined,
  isTrustedRendererIpcEvent: () => true,
  registerTrustedRendererUrl: () => undefined
}))
import { decode, encode } from '@msgpack/msgpack'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>(),
  root: '/tmp/ola-config-settings-ipc-fixture',
  windows: [] as Array<{
    isDestroyed: () => boolean
    webContents: {
      isDestroyed: () => boolean
      isCrashed: () => boolean
      postMessage: (channel: string, bytes: ArrayBuffer) => void
    }
  }>
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => state.root },
  BrowserWindow: { getAllWindows: () => state.windows },
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
  state.windows.length = 0
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

it('preserves corrupt settings and does not expose a failed mutation in the cache', async () => {
  await call('settings:write', { keep: 'value' })
  const path = join(state.root, 'settings.json')
  await writeFile(path, '{broken', 'utf8')

  await expect(call('settings:set', { key: 'new', value: true })).rejects.toThrow()
  await expect(readFile(path, 'utf8')).resolves.toBe('{broken')
  await expect(call<Record<string, unknown>>('settings:read')).resolves.toEqual({ keep: 'value' })
})

it('notifies windows only after settings commit without sending the value', async () => {
  const events: Array<{ channel: string; payload: unknown }> = []
  state.windows.push({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      postMessage: (channel, bytes) => {
        events.push({ channel, payload: decode(new Uint8Array(bytes)) })
      }
    }
  })

  await expect(
    call('settings:set', { key: 'ola-settings', value: { state: { fontSize: 18 } } })
  ).resolves.toEqual({ success: true })
  expect(events).toEqual([
    { channel: 'settings:changed:msgpack', payload: { key: 'ola-settings' } }
  ])

  await writeFile(join(state.root, 'settings.json'), '{broken', 'utf8')
  await expect(
    call('settings:set', { key: 'ola-settings', value: { state: { fontSize: 19 } } })
  ).rejects.toThrow()
  expect(events).toHaveLength(1)
})

it('serializes concurrent settings mutations before reporting success', async () => {
  await call('settings:write', { keep: 'value' })
  await expect(
    Promise.all([
      call('settings:set', { key: 'first', value: 1 }),
      call('settings:set', { key: 'second', value: 2 })
    ])
  ).resolves.toEqual([{ success: true }, { success: true }])
  await expect(call<Record<string, unknown>>('settings:read')).resolves.toEqual({
    keep: 'value',
    first: 1,
    second: 2
  })
})

it('merges independent window settings edits against the committed snapshot', async () => {
  await call('settings:set', {
    key: 'ola-settings',
    value: { state: { theme: 'light', fontSize: 16 }, version: 29 }
  })
  await expect(
    Promise.all([
      call('settings:set', {
        key: 'ola-settings',
        patch: { set: { theme: 'dark' }, remove: [], version: 29 }
      }),
      call('settings:set', {
        key: 'ola-settings',
        patch: { set: { fontSize: 18 }, remove: [], version: 29 }
      })
    ])
  ).resolves.toEqual([{ success: true }, { success: true }])
  await expect(call('settings:get', 'ola-settings')).resolves.toEqual({
    state: { theme: 'dark', fontSize: 18 },
    version: 29
  })
  await expect(
    call('settings:set', {
      key: 'ola-settings',
      patch: { set: { ['__proto__']: { injected: true } }, remove: [] }
    })
  ).rejects.toThrow()
})

it('merges independent edits inside the same settings object', async () => {
  await call('settings:set', {
    key: 'ola-settings',
    value: { state: { workProfileConfig: { approve: false, concurrency: 1 } }, version: 29 }
  })
  await Promise.all([
    call('settings:set', {
      key: 'ola-settings',
      patch: {
        set: {},
        remove: [],
        setPaths: [{ path: ['workProfileConfig', 'approve'], value: true }]
      }
    }),
    call('settings:set', {
      key: 'ola-settings',
      patch: {
        set: {},
        remove: [],
        setPaths: [{ path: ['workProfileConfig', 'concurrency'], value: 3 }]
      }
    })
  ])
  await expect(call('settings:get', 'ola-settings')).resolves.toMatchObject({
    state: { workProfileConfig: { approve: true, concurrency: 3 } }
  })
  await expect(
    call('settings:set', {
      key: 'ola-settings',
      patch: {
        set: {},
        remove: [],
        setPaths: [{ path: ['workProfileConfig', '__proto__'], value: {} }]
      }
    })
  ).rejects.toThrow('INVALID_SETTINGS_STATE_KEY')
})
