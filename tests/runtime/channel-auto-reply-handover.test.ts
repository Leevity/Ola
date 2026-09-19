import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  entered: false,
  release: null as (() => void) | null,
  routed: 0,
  pending: 0
}))

vi.mock('../../src/main/channels/channel-task-inbox', () => ({
  ChannelTaskInbox: class {
    pendingCount() {
      return state.pending
    }
    close() {
      return undefined
    }
  }
}))

vi.mock('../../src/main/channels/channel-config-store', () => ({
  readChannelPlugins: async () => {
    state.entered = true
    await new Promise<void>((resolve) => {
      state.release = resolve
    })
    return [
      {
        id: 'channel-a',
        type: 'test',
        name: 'Test',
        enabled: true,
        config: {},
        createdAt: 1,
        features: { autoReply: false }
      }
    ]
  }
}))
vi.mock('../../src/main/lib/native-worker', () => ({
  getNativeWorker: () => ({
    request: async () => {
      state.routed++
      return { success: true, sessionId: 'session-a' }
    }
  })
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => new Set()
}))
vi.mock('../../src/main/window-ipc', () => ({
  safeSendMessagePackToWorkspaceWindow: () => true
}))

import {
  handleChannelAutoReply,
  quiesceChannelAutoReplyForHandover
} from '../../src/main/channels/auto-reply'

const event = {
  type: 'incoming_message' as const,
  pluginId: 'channel-a',
  pluginType: 'test',
  data: {
    chatId: 'chat-a',
    senderId: 'sender-a',
    senderName: 'Sender',
    messageId: 'message-a',
    content: 'hello'
  }
}

it('drains an accepted channel route before refusing later messages', async () => {
  handleChannelAutoReply(event)
  await expect.poll(() => state.entered).toBe(true)
  let drained = false
  const quiesce = quiesceChannelAutoReplyForHandover().then(() => {
    drained = true
  })
  expect(drained).toBe(false)
  state.release?.()
  await quiesce
  expect(state.routed).toBe(1)
  expect(drained).toBe(true)
  expect(() => handleChannelAutoReply(event)).toThrow('CHANNEL_HANDOVER_QUIESCED')
})

it('refuses handover while a durable channel task still awaits completion', async () => {
  state.pending = 1
  await expect(quiesceChannelAutoReplyForHandover()).rejects.toThrow(
    'CHANNEL_TASKS_PENDING_DURING_HANDOVER'
  )
})

it('fails closed when an accepted route does not drain in time', async () => {
  vi.resetModules()
  state.entered = false
  state.release = null
  state.pending = 0
  const { handleChannelAutoReply: route, quiesceChannelAutoReplyForHandover: quiesce } =
    await import('../../src/main/channels/auto-reply')
  route(event)
  await expect.poll(() => state.entered).toBe(true)
  await expect(quiesce(20)).rejects.toThrow('CHANNEL_HANDOVER_DRAIN_TIMEOUT')
  expect(() => route(event)).toThrow('CHANNEL_HANDOVER_QUIESCED')
  const releaseRoute = state.release as (() => void) | null
  releaseRoute?.()
})
