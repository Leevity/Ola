import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  repository: {
    recordQqWakeupSource: vi.fn(),
    resolveQqWakeupEligibility: vi.fn(),
    markQqWakeupSent: vi.fn()
  }
}))

vi.mock('../../src/main/db/business-write-canary', () => ({
  businessWriteCanary: () => state.repository,
  getTsDatabaseRouteGuard: () => {
    throw new Error('QQ wakeup DAO unexpectedly entered legacy route')
  }
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => new Set(['team-a'])
}))

import {
  markQqWakeupSent,
  recordQqWakeupSource,
  resolveQqWakeupEligibility
} from '../../src/main/db/qq-wakeup-dao'

beforeEach(() => {
  state.repository.recordQqWakeupSource.mockReset()
  state.repository.resolveQqWakeupEligibility.mockReset()
  state.repository.markQqWakeupSent.mockReset()
  state.repository.resolveQqWakeupEligibility.mockResolvedValue({
    enabled: true,
    periodKey: '2026-09-20',
    sourceMessageId: 'message-a',
    sourceTimestamp: 1
  })
})

it('routes QQ wakeup source, eligibility, and sent state through TS storage', async () => {
  await recordQqWakeupSource({
    pluginId: 'qq-plugin',
    openId: 'open-a',
    workspaceId: 'team-a',
    sourceMessageId: 'message-a',
    sourceTimestamp: 1,
    now: 2
  })
  await expect(resolveQqWakeupEligibility('qq-plugin', 'open-a', 'team-a', 3)).resolves.toEqual({
    enabled: true,
    periodKey: '2026-09-20',
    sourceMessageId: 'message-a',
    sourceTimestamp: 1
  })
  await markQqWakeupSent({
    pluginId: 'qq-plugin',
    openId: 'open-a',
    workspaceId: 'team-a',
    periodKey: '2026-09-20',
    sourceMessageId: 'message-a',
    sourceTimestamp: 1,
    now: 4
  })

  expect(state.repository.recordQqWakeupSource).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: 'team-a', now: 2 })
  )
  expect(state.repository.resolveQqWakeupEligibility).toHaveBeenCalledWith({
    pluginId: 'qq-plugin',
    openId: 'open-a',
    workspaceId: 'team-a',
    now: 3
  })
  expect(state.repository.markQqWakeupSent).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: 'team-a', now: 4 })
  )
})
