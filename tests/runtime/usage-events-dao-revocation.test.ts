import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  authorizations: [] as boolean[],
  canaryRows: undefined as Array<{ id: string }> | undefined,
  canaryActivity: undefined as { row: { request_count: number } } | undefined,
  nativeCalls: 0
}))

vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => new Set(state.authorizations.shift() ? ['team-a'] : [])
}))
vi.mock('../../src/main/db/legacy-read-canary', () => ({
  canaryListUsageEvents: async () => state.canaryRows,
  canaryGetUsageOverview: async () => undefined,
  canaryGetUsageActivity: async () => state.canaryActivity
}))
vi.mock('../../src/main/lib/native-worker', () => ({
  getNativeWorker: () => ({
    request: async () => {
      state.nativeCalls += 1
      return { success: true, row: { request_count: 1 }, rows: [{ id: 'native-row' }] }
    }
  })
}))

import {
  getUsageActivityOverview,
  getUsageOverview,
  listUsageEvents
} from '../../src/main/db/usage-events-dao'

beforeEach(() => {
  state.authorizations = []
  state.canaryRows = undefined
  state.canaryActivity = undefined
  state.nativeCalls = 0
})

describe('usage read authorization at result delivery', () => {
  it('does not expose a TS canary result after offline team authorization is revoked', async () => {
    state.authorizations = [true, false]
    state.canaryRows = [{ id: 'team-private' }]
    await expect(listUsageEvents({ workspaceId: 'team-a', from: 0, to: 1 })).rejects.toThrow(
      'Usage workspace is not available'
    )
    expect(state.nativeCalls).toBe(0)
  })

  it('does not expose a Native usage result after offline team authorization is revoked', async () => {
    state.authorizations = [true, true, false]
    await expect(getUsageOverview({ workspaceId: 'team-a', from: 0, to: 1 })).rejects.toThrow(
      'Usage workspace is not available'
    )
    expect(state.nativeCalls).toBe(1)
  })

  it('does not expose activity aggregates after offline team authorization is revoked', async () => {
    state.authorizations = [true, false]
    state.canaryActivity = { row: { request_count: 7 } }
    await expect(
      getUsageActivityOverview({ workspaceId: 'team-a', from: 0, to: 1 })
    ).rejects.toThrow('Usage workspace is not available')
    expect(state.nativeCalls).toBe(0)
  })
})
