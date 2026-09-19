import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelInstance } from '../../src/main/channels/channel-types'

const state = vi.hoisted(() => ({
  available: new Set(['team-a']),
  canDeliver: false,
  revokeAfterDeliver: false,
  autoReplyEnabled: true,
  pendingDeferred: false,
  enqueued: 0,
  routeCalls: 0,
  delivered: [] as unknown[],
  rows: [
    {
      sequence: 1,
      id: 'task-1',
      workspaceId: 'team-a',
      pluginId: 'team-plugin',
      chatId: 'chat-a',
      messageId: 'message-a',
      payload: { content: 'private message' },
      status: 'pending'
    }
  ] as Array<{
    sequence: number
    id: string
    workspaceId: string
    pluginId: string
    chatId: string
    messageId: string
    payload: unknown
    status: string
  }>
}))

vi.mock('../../src/main/channels/channel-task-inbox', () => ({
  ChannelTaskInbox: class {
    enqueue() {
      state.enqueued += 1
      return { status: 'delivered' }
    }
    pending(workspaceId: string, _limit: number, afterSequence: number) {
      if (state.pendingDeferred) return []
      return state.rows.filter(
        (row) =>
          row.workspaceId === workspaceId &&
          row.status === 'pending' &&
          row.sequence > afterSequence
      )
    }
    nextRetryDelayMs(workspaceId: string) {
      return state.rows.some((row) => row.workspaceId === workspaceId && row.status === 'pending')
        ? state.pendingDeferred
          ? 1_500
          : 30_000
        : null
    }
    markDelivered(id: string, workspaceId: string) {
      const row = state.rows.find((item) => item.id === id && item.workspaceId === workspaceId)
      if (!row) return false
      row.status = 'delivered'
      return true
    }
    markSent() {
      return true
    }
    close() {
      state.canDeliver = false
    }
  }
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
      workspaceId: 'team-a',
      features: { autoReply: state.autoReplyEnabled, streamingReply: true, autoStart: true }
    }
  ]
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => state.available
}))
vi.mock('../../src/main/window-ipc', () => ({
  safeSendMessagePackToWorkspaceWindow: (
    _workspaceId: string,
    _channel: string,
    payload: unknown
  ) => {
    if (!state.canDeliver) return false
    state.delivered.push(payload)
    if (state.revokeAfterDeliver) state.available = new Set()
    return true
  }
}))
vi.mock('../../src/main/lib/native-worker', () => ({
  getNativeWorker: () => ({
    request: async () => {
      state.routeCalls += 1
      return { success: true, sessionId: 'session-a' }
    }
  })
}))
vi.mock('../../src/main/channels/plugin-commands', () => ({ tryHandleCommand: async () => false }))

import {
  acknowledgeChannelTaskDelivery,
  closeChannelTaskInbox,
  flushPendingChannelTasks,
  handleChannelAutoReply
} from '../../src/main/channels/auto-reply'

beforeEach(() => {
  state.available = new Set(['team-a'])
  state.canDeliver = false
  state.revokeAfterDeliver = false
  state.autoReplyEnabled = true
  state.pendingDeferred = false
  state.enqueued = 0
  state.routeCalls = 0
  state.delivered = []
  state.rows = [
    {
      sequence: 1,
      id: 'task-1',
      workspaceId: 'team-a',
      pluginId: 'team-plugin',
      chatId: 'chat-a',
      messageId: 'message-a',
      payload: { content: 'private message' },
      status: 'pending'
    }
  ]
})

afterEach(() => {
  closeChannelTaskInbox()
})

describe('pending channel task delivery', () => {
  it('schedules recovery when only recently sent unacknowledged tasks remain', async () => {
    state.pendingDeferred = true
    const timer = vi.spyOn(global, 'setTimeout')
    try {
      await flushPendingChannelTasks('team-a')
      expect(timer).toHaveBeenCalledWith(expect.any(Function), 1_500)
    } finally {
      timer.mockRestore()
    }
  })

  it('does not persist an automatic reply task when the channel has disabled auto-reply', async () => {
    state.autoReplyEnabled = false
    handleChannelAutoReply({
      type: 'incoming_message',
      pluginId: 'team-plugin',
      pluginType: 'feishu-bot',
      data: {
        chatId: 'chat-a',
        senderId: 'sender',
        senderName: 'Sender',
        content: 'hello',
        messageId: 'message-a'
      }
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.routeCalls).toBe(1)
    expect(state.enqueued).toBe(0)
  })

  it('keeps tasks queued without a window, flushes after registration and rejects revoked teams', async () => {
    await flushPendingChannelTasks('team-a')
    expect(state.rows[0].status).toBe('pending')
    expect(state.delivered).toEqual([])

    state.canDeliver = true
    await flushPendingChannelTasks('team-a')
    expect(state.rows[0].status).toBe('pending')
    expect(state.delivered).toEqual([{ content: 'private message', deliveryId: 'task-1' }])
    expect(acknowledgeChannelTaskDelivery('local-personal', 'task-1')).toBe(false)
    expect(acknowledgeChannelTaskDelivery('team-a', 'task-1')).toBe(true)
    expect(state.rows[0].status).toBe('delivered')

    state.rows.push({ ...state.rows[0], id: 'task-2', sequence: 2, status: 'pending' })
    state.available = new Set()
    await expect(flushPendingChannelTasks('team-a')).rejects.toThrow(
      'CHANNEL_WORKSPACE_UNAVAILABLE'
    )
    expect(state.rows[1].status).toBe('pending')
    expect(state.delivered).toHaveLength(1)

    state.rows.push({ ...state.rows[1], id: 'task-3', sequence: 3 })
    state.available = new Set(['team-a'])
    state.revokeAfterDeliver = true
    await expect(flushPendingChannelTasks('team-a')).rejects.toThrow(
      'CHANNEL_WORKSPACE_UNAVAILABLE'
    )
    expect(state.delivered).toHaveLength(2)
    expect(state.rows[2].status).toBe('pending')
  })
})
