import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  request: vi.fn(),
  canary: vi.fn()
}))

vi.mock('../../src/main/lib/native-worker', () => ({
  getNativeWorker: () => ({ request: state.request })
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => state.allowed
}))
vi.mock('../../src/main/db/legacy-read-canary', () => ({
  canaryResolveQqWakeupEligibility: state.canary
}))

import {
  markQqWakeupSent,
  recordQqWakeupSource,
  resolveQqWakeupEligibility
} from '../../src/main/db/qq-wakeup-dao'

beforeEach(() => {
  state.allowed = new Set(['team-a'])
  state.request.mockReset()
  state.canary.mockReset()
  state.canary.mockResolvedValue(undefined)
  state.request.mockResolvedValue({
    success: true,
    enabled: true,
    periodKey: 'day-0',
    sourceMessageId: null,
    sourceTimestamp: 100,
    changed: 1
  })
})

describe('QQ wakeup Main workspace boundary', () => {
  it('passes authorized ownership to Native and refuses revoked teams before access', async () => {
    await expect(
      resolveQqWakeupEligibility('plugin', 'open-id', 'team-a', 100)
    ).resolves.toMatchObject({
      enabled: true,
      periodKey: 'day-0'
    })
    expect(state.request).toHaveBeenCalledWith(
      'db/qq-wakeup-resolve',
      { pluginId: 'plugin', openId: 'open-id', workspaceId: 'team-a', now: 100 },
      120_000
    )
    state.allowed.clear()
    await expect(resolveQqWakeupEligibility('plugin', 'open-id', 'team-a', 100)).rejects.toThrow(
      'CHANNEL_WORKSPACE_UNAVAILABLE'
    )
    await expect(
      markQqWakeupSent({
        pluginId: 'plugin',
        openId: 'open-id',
        workspaceId: 'team-a',
        periodKey: 'day-0',
        sourceMessageId: null,
        sourceTimestamp: 100,
        now: 101
      })
    ).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
    await expect(
      recordQqWakeupSource({
        pluginId: 'plugin',
        openId: 'open-id',
        workspaceId: 'team-a',
        sourceMessageId: 'source-id',
        sourceTimestamp: 100,
        now: 101
      })
    ).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
    expect(state.request).toHaveBeenCalledTimes(1)
  })

  it('uses the TS read and rechecks authorization before returning it', async () => {
    state.canary.mockResolvedValue({
      enabled: true,
      periodKey: 'day-0',
      sourceMessageId: 'source',
      sourceTimestamp: 90
    })
    await expect(resolveQqWakeupEligibility('plugin', 'open-id', 'team-a', 100)).resolves.toEqual({
      enabled: true,
      periodKey: 'day-0',
      sourceMessageId: 'source',
      sourceTimestamp: 90
    })
    expect(state.request).not.toHaveBeenCalled()
    state.canary.mockImplementation(async () => {
      state.allowed.clear()
      return { enabled: true, periodKey: 'day-0', sourceMessageId: 'source', sourceTimestamp: 90 }
    })
    await expect(resolveQqWakeupEligibility('plugin', 'open-id', 'team-a', 100)).rejects.toThrow(
      'CHANNEL_WORKSPACE_UNAVAILABLE'
    )
    expect(state.request).not.toHaveBeenCalled()
  })

  it('does not return a Native eligibility read after team access is revoked in flight', async () => {
    state.request.mockImplementation(async () => {
      state.allowed.clear()
      return {
        success: true,
        enabled: true,
        periodKey: 'day-0',
        sourceMessageId: null,
        sourceTimestamp: 90
      }
    })
    await expect(resolveQqWakeupEligibility('plugin', 'open-id', 'team-a', 100)).rejects.toThrow(
      'CHANNEL_WORKSPACE_UNAVAILABLE'
    )
  })
})
