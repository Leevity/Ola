import { afterEach, describe, expect, it, vi } from 'vitest'

const { appendTeamRuntimeMessage, cancelTsRuntimeRun, getActiveTeamWorkspaceId, activeTeam } =
  vi.hoisted(() => ({
    appendTeamRuntimeMessage: vi.fn(),
    cancelTsRuntimeRun: vi.fn(),
    getActiveTeamWorkspaceId: vi.fn(() => 'workspace-id'),
    activeTeam: {
      name: 'runtime-team',
      members: [
        { id: 'lead-id', name: 'lead', role: 'lead', status: 'working' },
        {
          id: 'worker-id',
          name: 'worker',
          role: 'worker',
          status: 'working',
          runId: 'child-run-id'
        },
        { id: 'done-id', name: 'done', role: 'worker', status: 'completed' }
      ]
    }
  }))

vi.mock('../../src/renderer/src/lib/agent/teams/runtime-client', () => ({
  appendTeamRuntimeMessage,
  getActiveTeamWorkspaceId
}))

vi.mock('../../src/renderer/src/lib/ipc/ts-runtime-bridge', () => ({
  cancelTsRuntimeRun
}))

vi.mock('../../src/renderer/src/stores/team-store', () => ({
  useTeamStore: { getState: () => ({ activeTeam }) }
}))

import {
  abortAllTeammates,
  abortTeammate
} from '../../src/renderer/src/lib/agent/teams/team-native-control'

describe('team runtime UI controls', () => {
  afterEach(() => vi.clearAllMocks())

  it('persists a shutdown request for an active worker only', async () => {
    appendTeamRuntimeMessage.mockResolvedValue({ success: true })
    cancelTsRuntimeRun.mockResolvedValue(true)

    await expect(abortTeammate('worker')).resolves.toBe(true)
    expect(appendTeamRuntimeMessage).toHaveBeenCalledWith({
      teamName: 'runtime-team',
      message: expect.objectContaining({
        from: 'lead',
        to: 'worker',
        type: 'shutdown_request',
        content: JSON.stringify({ memberId: 'worker-id' })
      })
    })
    expect(cancelTsRuntimeRun).toHaveBeenCalledWith({
      workspaceId: 'workspace-id',
      runId: 'child-run-id'
    })
    await expect(abortTeammate('lead-id')).resolves.toBe(false)
    await expect(abortTeammate('done-id')).resolves.toBe(false)
  })

  it('sends shutdown requests to every active worker', async () => {
    appendTeamRuntimeMessage.mockResolvedValue({ success: true })

    await abortAllTeammates()

    expect(appendTeamRuntimeMessage).toHaveBeenCalledTimes(1)
    expect(appendTeamRuntimeMessage).toHaveBeenCalledWith({
      teamName: 'runtime-team',
      message: expect.objectContaining({ to: 'worker', type: 'shutdown_request' })
    })
  })
})
