import { describe, expect, it, vi } from 'vitest'
vi.mock('../../src/main/renderer-security', () => ({
  assertTrustedRendererIpcEvent: () => undefined,
  isTrustedRendererIpcEvent: () => true,
  registerTrustedRendererUrl: () => undefined
}))
import type { ChannelManager } from '../../src/main/channels/channel-manager'
import type {
  ChannelInstance,
  ChannelStreamingHandle,
  MessagingChannelService
} from '../../src/main/channels/channel-types'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload
} from '../../src/shared/messagepack/binary-ipc'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>(),
  workspaces: new Set(['team-a'])
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => state.handlers.set(channel, handler)
  },
  BrowserWindow: class {}
}))
vi.mock('../../src/main/channels/channel-config-store', () => ({
  readChannelPlugins: async (): Promise<ChannelInstance[]> => [
    {
      id: 'team-plugin',
      type: 'feishu-bot',
      name: 'Team',
      enabled: true,
      config: {},
      createdAt: 1,
      workspaceId: 'team-a'
    }
  ],
  writeChannelPlugins: async () => {},
  isChannelPluginToolEnabled: async () => true
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => state.workspaces
}))

import { registerChannelHandlers } from '../../src/main/ipc/channel-handlers'

describe('channel streaming IPC workspace ownership', () => {
  it('checks persisted ownership on every operation and binds a stream to its chat', async () => {
    const updates: string[] = []
    const finishes: string[] = []
    const starts: string[] = []
    let signalSlowStart: (() => void) | undefined
    let resolveSlowStart: ((handle: ChannelStreamingHandle) => void) | undefined
    const slowStartReady = new Promise<void>((resolve) => {
      signalSlowStart = resolve
    })
    const service = {
      supportsStreaming: true,
      sendStreamingMessage: async (chatId: string) => {
        starts.push(chatId)
        if (chatId === 'slow-chat') {
          return await new Promise<ChannelStreamingHandle>((resolve) => {
            resolveSlowStart = resolve
            signalSlowStart?.()
          })
        }
        return {
          update: async (content: string) => {
            updates.push(content)
          },
          finish: async (content: string) => {
            finishes.push(content)
          }
        }
      }
    } as unknown as MessagingChannelService
    let currentService: MessagingChannelService | undefined = service
    registerChannelHandlers({
      getService: () => currentService
    } as unknown as ChannelManager)
    const invoke = async (channel: string, args: Record<string, unknown>): Promise<unknown> => {
      const handler = state.handlers.get(`${channel}:msgpack`)
      expect(handler).toBeDefined()
      return decodeMessagePackPayload(await handler!(undefined, encodeMessagePackPayload(args)))
    }
    const stream = {
      pluginId: 'team-plugin',
      workspaceId: 'team-a',
      chatId: 'team-chat',
      streamId: 'stream-1'
    }

    await expect(
      invoke('plugin:stream:start', {
        ...stream,
        workspaceId: 'local-personal',
        initialContent: ''
      })
    ).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
    expect(starts).toEqual([])
    expect(await invoke('plugin:stream:start', { ...stream, initialContent: '' })).toMatchObject({
      ok: true
    })
    expect(starts).toEqual(['team-chat'])
    await expect(
      invoke('plugin:stream:update', { ...stream, workspaceId: 'local-personal', content: 'bad' })
    ).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
    expect(
      await invoke('plugin:stream:update', { ...stream, chatId: 'other-chat', content: 'bad' })
    ).toMatchObject({ ok: false })
    expect(await invoke('plugin:stream:update', { ...stream, content: 'first' })).toMatchObject({
      ok: true
    })
    await expect(
      invoke('plugin:stream:append', { ...stream, workspaceId: 'local-personal', delta: 'bad' })
    ).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
    expect(
      await invoke('plugin:stream:append', { ...stream, chatId: 'other-chat', delta: 'bad' })
    ).toMatchObject({ ok: false })
    expect(await invoke('plugin:stream:append', { ...stream, delta: 'hello' })).toMatchObject({
      ok: true
    })
    expect(updates).toEqual(['first', 'firsthello'])

    state.workspaces = new Set()
    await expect(invoke('plugin:stream:finish', { ...stream, content: 'hello' })).rejects.toThrow(
      'CHANNEL_WORKSPACE_UNAVAILABLE'
    )
    expect(finishes).toEqual([])
    state.workspaces = new Set(['team-a'])
    expect(
      await invoke('plugin:stream:finish', { ...stream, content: 'firsthello' })
    ).toMatchObject({ ok: false })
    expect(finishes).toEqual([])
    expect(await invoke('plugin:stream:start', { ...stream, initialContent: '' })).toMatchObject({
      ok: true
    })
    expect(
      await invoke('plugin:stream:finish', { ...stream, content: 'firsthello' })
    ).toMatchObject({ ok: true })
    expect(finishes).toEqual(['firsthello'])

    const staleStream = { ...stream, streamId: 'stale-stream' }
    expect(
      await invoke('plugin:stream:start', { ...staleStream, initialContent: '' })
    ).toMatchObject({
      ok: true
    })
    currentService = undefined
    expect(
      await invoke('plugin:stream:append', { ...staleStream, delta: 'discarded' })
    ).toMatchObject({
      ok: false
    })
    currentService = service
    expect(
      await invoke('plugin:stream:finish', { ...staleStream, content: 'discarded' })
    ).toMatchObject({
      ok: false
    })
    expect(updates).toEqual(['first', 'firsthello'])
    expect(finishes).toEqual(['firsthello'])
    const slowStream = { ...stream, chatId: 'slow-chat', streamId: 'slow-stream' }
    const pendingStart = invoke('plugin:stream:start', { ...slowStream, initialContent: '' })
    await slowStartReady
    currentService = undefined
    resolveSlowStart?.({ update: async () => {}, finish: async () => {} })
    expect(await pendingStart).toMatchObject({ ok: false, error: 'CHANNEL_STREAM_SERVICE_CHANGED' })
    currentService = service
    expect(
      await invoke('plugin:stream:append', { ...slowStream, delta: 'discarded' })
    ).toMatchObject({
      ok: false
    })
  })
})
