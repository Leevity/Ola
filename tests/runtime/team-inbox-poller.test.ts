import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  getTeamRuntimeSnapshot,
  consumeTeamRuntimeMessages,
  appendTeamRuntimeMessage,
  syncRuntimeSnapshot,
  activeTeam
} = vi.hoisted(() => ({
  getTeamRuntimeSnapshot: vi.fn(),
  consumeTeamRuntimeMessages: vi.fn(),
  appendTeamRuntimeMessage: vi.fn(),
  syncRuntimeSnapshot: vi.fn(),
  activeTeam: { name: 'runtime-team', sessionId: 'lead-session' }
}))

vi.mock('../../src/renderer/src/lib/agent/teams/runtime-client', () => ({
  getTeamRuntimeSnapshot,
  consumeTeamRuntimeMessages,
  appendTeamRuntimeMessage
}))

vi.mock('../../src/renderer/src/stores/team-store', () => ({
  useTeamStore: {
    getState: () => ({ activeTeam, syncRuntimeSnapshot })
  }
}))

vi.mock('../../src/renderer/src/stores/agent-store', () => ({
  useAgentStore: { getState: () => ({}) }
}))

import {
  startTeamInboxPoller,
  stopTeamInboxPoller
} from '../../src/renderer/src/lib/agent/teams/inbox-poller'

describe('team runtime inbox poller', () => {
  afterEach(() => {
    stopTeamInboxPoller()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('refreshes the workspace-scoped snapshot without overlapping polls', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    getTeamRuntimeSnapshot.mockImplementationOnce(async () => {
      await pending
      return { team: { name: 'runtime-team' }, recentMessages: [] }
    })
    consumeTeamRuntimeMessages.mockResolvedValue([])

    startTeamInboxPoller()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(getTeamRuntimeSnapshot).toHaveBeenCalledTimes(1)
    expect(consumeTeamRuntimeMessages).toHaveBeenCalledTimes(1)

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(syncRuntimeSnapshot).toHaveBeenCalledTimes(1)
    expect(syncRuntimeSnapshot).toHaveBeenCalledWith(
      { team: { name: 'runtime-team' }, recentMessages: [] },
      'lead-session'
    )
  })

  it('stops the timer and clears the poller state', async () => {
    vi.useFakeTimers()
    getTeamRuntimeSnapshot.mockResolvedValue({ team: { name: 'runtime-team' }, recentMessages: [] })
    consumeTeamRuntimeMessages.mockResolvedValue([])

    startTeamInboxPoller()
    stopTeamInboxPoller()
    await vi.advanceTimersByTimeAsync(2000)

    expect(getTeamRuntimeSnapshot).not.toHaveBeenCalled()
    expect(appendTeamRuntimeMessage).not.toHaveBeenCalled()
  })
})
