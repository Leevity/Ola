import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/stores/chat-store', () => ({
  useChatStore: { getState: () => ({ sessions: [] }), setState: vi.fn() }
}))
vi.mock('../../src/renderer/src/stores/provider-store', () => ({
  useProviderStore: { getState: () => ({}) }
}))

import { useWorkspaceStore } from '../../src/renderer/src/stores/workspace-store'
import {
  initChannelEventListener,
  markChannelTaskAccepted,
  releaseUnacceptedChannelTask,
  useChannelStore
} from '../../src/renderer/src/stores/channel-store'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload
} from '../../src/shared/messagepack/binary-ipc'
import { beginChannelTaskWorkspaceSwitch } from '../../src/renderer/src/lib/channel/channel-task-activity'

afterEach(() => {
  vi.unstubAllGlobals()
  useWorkspaceStore.setState({ activeWorkspaceId: 'local-personal' })
  useChannelStore.getState().resetForWorkspace()
})

describe('channel store workspace IPC', () => {
  it('deduplicates tasks per workspace, plugin and chat rather than raw provider message ID', () => {
    const handlers = new Map<string, (bytes: Uint8Array) => void>()
    const dispatched: unknown[] = []
    const acknowledgements: Array<{ channel: string; payload: unknown }> = []
    vi.stubGlobal(
      'CustomEvent',
      class {
        constructor(_name: string, options: { detail: unknown }) {
          this.detail = options.detail
        }
        detail: unknown
      }
    )
    vi.stubGlobal('window', {
      __pluginAutoReplyListenerActive: true,
      ola: {
        ipc: {
          on: (channel: string, handler: (bytes: Uint8Array) => void) => {
            handlers.set(channel, handler)
            return () => {}
          },
          invoke: async (channel: string, bytes: Uint8Array) => {
            acknowledgements.push({ channel, payload: decodeMessagePackPayload(bytes) })
            return encodeMessagePackPayload({ acknowledged: true })
          }
        }
      },
      dispatchEvent: (event: { detail: unknown }) => dispatched.push(event.detail)
    })
    useWorkspaceStore.setState({ activeWorkspaceId: 'team-a' })
    useChannelStore.setState({
      channels: [
        {
          id: 'one',
          type: 'qq-bot',
          name: 'One',
          enabled: true,
          config: {},
          createdAt: 1,
          workspaceId: 'team-a'
        },
        {
          id: 'two',
          type: 'qq-bot',
          name: 'Two',
          enabled: true,
          config: {},
          createdAt: 1,
          workspaceId: 'team-a'
        }
      ]
    })
    initChannelEventListener()
    const receive = handlers.get('plugin:session-task:msgpack')
    expect(receive).toBeDefined()
    const task = {
      sessionId: 'session',
      workspaceId: 'team-a',
      pluginId: 'one',
      chatId: 'chat-a',
      messageId: 'same-id',
      deliveryId: 'delivery-1'
    }
    const releaseSwitch = beginChannelTaskWorkspaceSwitch()
    expect(releaseSwitch).not.toBeNull()
    receive!(encodeMessagePackPayload(task))
    expect(dispatched).toHaveLength(0)
    releaseSwitch?.()
    receive!(encodeMessagePackPayload(task))
    receive!(encodeMessagePackPayload(task))
    expect(dispatched).toHaveLength(1)
    expect(acknowledgements).toEqual([])
    // The bounded recent-message cache may evict this key during a long run.
    // The active delivery lease must still prevent a second Agent turn.
    window.__pluginDispatchedIds?.clear()
    receive!(encodeMessagePackPayload(task))
    expect(dispatched).toHaveLength(1)
    markChannelTaskAccepted(task)
    receive!(encodeMessagePackPayload(task))
    expect(acknowledgements).toEqual(
      ['delivery-1', 'delivery-1'].map((deliveryId) => ({
        channel: 'plugin:session-task:ack:msgpack',
        payload: { workspaceId: 'team-a', deliveryId }
      }))
    )
    receive!(encodeMessagePackPayload({ ...task, chatId: 'chat-b', deliveryId: 'delivery-2' }))
    receive!(encodeMessagePackPayload({ ...task, pluginId: 'two', deliveryId: 'delivery-3' }))
    expect(dispatched).toHaveLength(3)
    expect(acknowledgements).toHaveLength(2)
    const unaccepted = { ...task, chatId: 'chat-b', deliveryId: 'delivery-2' }
    releaseUnacceptedChannelTask(unaccepted)
    receive!(encodeMessagePackPayload(unaccepted))
    expect(dispatched).toHaveLength(4)
    window.__pluginAutoReplyListenerActive = false
    receive!(encodeMessagePackPayload({ ...task, messageId: 'later', deliveryId: 'delivery-4' }))
    expect(dispatched).toHaveLength(4)
    expect(acknowledgements).toHaveLength(2)
  })

  it('scopes channel listing and rejects a delayed response from the previous space', async () => {
    let release!: (value: Uint8Array) => void
    const pending = new Promise<Uint8Array>((resolve) => {
      release = resolve
    })
    const calls: Array<{ channel: string; payload: Record<string, unknown> }> = []
    vi.stubGlobal('window', {
      ola: {
        ipc: {
          invoke: async (channel: string, bytes: Uint8Array) => {
            calls.push({ channel, payload: decodeMessagePackPayload(bytes) })
            return calls.length === 1 ? pending : encodeMessagePackPayload([])
          }
        }
      }
    })
    useWorkspaceStore.setState({ activeWorkspaceId: 'team-a' })
    const oldLoad = useChannelStore.getState().loadChannels()
    useWorkspaceStore.setState({ activeWorkspaceId: 'local-personal' })
    useChannelStore.getState().resetForWorkspace()
    await useChannelStore.getState().loadChannels()
    release(
      encodeMessagePackPayload([
        {
          id: 'team-channel',
          workspaceId: 'team-a',
          type: 'qq-bot',
          name: 'Team',
          enabled: true,
          config: {},
          createdAt: 1
        }
      ])
    )
    await oldLoad
    expect(calls.map(({ payload }) => payload)).toEqual([
      { workspaceId: 'team-a' },
      { workspaceId: 'local-personal' }
    ])
    expect(useChannelStore.getState().channels).toEqual([])
  })

  it('sends explicit ownership for channel control and mutation requests', async () => {
    const calls: Array<{ channel: string; payload: Record<string, unknown> }> = []
    vi.stubGlobal('window', {
      ola: {
        ipc: {
          invoke: async (channel: string, bytes: Uint8Array) => {
            calls.push({ channel, payload: decodeMessagePackPayload(bytes) })
            return encodeMessagePackPayload(
              channel.includes('plugin:status') ? 'stopped' : { success: true }
            )
          }
        }
      }
    })
    useWorkspaceStore.setState({ activeWorkspaceId: 'team-a' })
    useChannelStore.setState({
      channels: [
        {
          id: 'team-plugin',
          type: 'qq-bot',
          name: 'Team',
          enabled: true,
          config: {},
          createdAt: 1,
          workspaceId: 'team-a'
        }
      ]
    })
    await useChannelStore.getState().startChannel('team-plugin')
    await useChannelStore.getState().refreshChannelStatus('team-plugin')
    await useChannelStore.getState().updateChannel('team-plugin', { name: 'Updated' })
    await useChannelStore.getState().stopChannel('team-plugin')
    await useChannelStore.getState().removeChannel('team-plugin')
    expect(calls.map(({ payload }) => payload.workspaceId)).toEqual(Array(5).fill('team-a'))
    expect(calls.map(({ channel }) => channel)).toEqual([
      'plugin:start:msgpack',
      'plugin:status:msgpack',
      'plugin:update:msgpack',
      'plugin:stop:msgpack',
      'plugin:remove:msgpack'
    ])
  })
})
