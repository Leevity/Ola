import { describe, expect, it, vi } from 'vitest'
import type { ChannelEvent, ChannelInstance } from '../../src/main/channels/channel-types'

const recordSource = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const workspaces = vi.hoisted(() => ({ allowed: new Set(['team-a']) }))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => workspaces.allowed
}))
vi.mock('../../src/main/db/qq-wakeup-dao', () => ({
  recordQqWakeupSource: recordSource,
  resolveQqWakeupEligibility: vi.fn(),
  markQqWakeupSent: vi.fn()
}))

import { QQService } from '../../src/main/channels/providers/qq/qq-service'

function instance(workspaceId: string): ChannelInstance {
  return {
    id: 'qq-plugin',
    type: 'qq-bot',
    name: 'QQ',
    enabled: true,
    config: {},
    createdAt: 1,
    workspaceId
  }
}

describe('QQ inbound wakeup source', () => {
  it('persists the raw C2C message before emitting it and ignores group messages', async () => {
    recordSource.mockClear()
    workspaces.allowed = new Set(['team-a'])
    const events: ChannelEvent[] = []
    recordSource.mockImplementationOnce(async () => {
      expect(events).toEqual([])
    })
    const service = new QQService(instance('team-a'), (event) => events.push(event))
    const dispatch = service as unknown as { handleGatewayMessage(raw: string): Promise<void> }
    await dispatch.handleGatewayMessage(
      JSON.stringify({
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        d: {
          id: 'raw-message-id',
          author: { user_openid: 'user-open-id' },
          content: 'hello',
          timestamp: '2026-09-18T00:00:00.000Z'
        }
      })
    )
    expect(recordSource).toHaveBeenCalledWith({
      pluginId: 'qq-plugin',
      openId: 'user-open-id',
      workspaceId: 'team-a',
      sourceMessageId: 'raw-message-id',
      sourceTimestamp: Date.parse('2026-09-18T00:00:00.000Z')
    })
    expect(events.map((event) => event.type)).toEqual(['incoming_message'])

    await dispatch.handleGatewayMessage(
      JSON.stringify({
        op: 0,
        t: 'GROUP_AT_MESSAGE_CREATE',
        d: {
          id: 'group-message-id',
          author: { member_openid: 'member-open-id' },
          group_openid: 'group-open-id',
          content: 'group hello'
        }
      })
    )
    expect(recordSource).toHaveBeenCalledTimes(1)
    expect(events.map((event) => event.type)).toEqual(['incoming_message', 'incoming_message'])

    workspaces.allowed.clear()
    await expect(
      dispatch.handleGatewayMessage(
        JSON.stringify({
          op: 0,
          t: 'GROUP_AT_MESSAGE_CREATE',
          d: {
            id: 'revoked-message-id',
            author: { member_openid: 'member-open-id' },
            group_openid: 'group-open-id',
            content: 'revoked message'
          }
        })
      )
    ).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
    expect(events).toHaveLength(2)
  })
})
