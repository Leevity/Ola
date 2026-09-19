import { describe, expect, it } from 'vitest'
import {
  assertAgentChangeSetWorkspace,
  assertAgentChangeWorkspace
} from '../../src/main/ipc/agent-change-workspace'

const dependencies = {
  sessionWorkspace: async (sessionId: string): Promise<string | null> =>
    ({ personal: 'local-personal', team: 'team-a' })[sessionId] ?? null,
  availableWorkspaceIds: async (): Promise<ReadonlySet<string>> => new Set(['team-a'])
}

describe('agent change journal workspace authorization', () => {
  it('accepts only an available workspace matching the persisted session', async () => {
    await expect(assertAgentChangeWorkspace('team-a', 'team', dependencies)).resolves.toBe('team-a')
    await expect(
      assertAgentChangeWorkspace('local-personal', 'personal', dependencies)
    ).resolves.toBe('local-personal')
    await expect(assertAgentChangeWorkspace('local-personal', null, dependencies)).resolves.toBe(
      'local-personal'
    )
  })

  it('rejects missing, revoked and cross-workspace requests before exposing snapshots', async () => {
    await expect(assertAgentChangeWorkspace(undefined, 'team', dependencies)).rejects.toThrow(
      'agent-change-workspace-required'
    )
    await expect(assertAgentChangeWorkspace('team-b', 'team', dependencies)).rejects.toThrow(
      'agent-change-workspace-unavailable'
    )
    await expect(assertAgentChangeWorkspace('team-a', 'personal', dependencies)).rejects.toThrow(
      'agent-change-session-workspace-mismatch'
    )
    await expect(
      assertAgentChangeWorkspace('local-personal', 'team', dependencies)
    ).rejects.toThrow('agent-change-session-workspace-mismatch')
    await expect(assertAgentChangeWorkspace('team-a', null, dependencies)).rejects.toThrow(
      'agent-change-session-required'
    )
  })

  it('checks every file-change session, including when the parent has no session', async () => {
    await expect(
      assertAgentChangeSetWorkspace('team-a', [null, 'team'], dependencies)
    ).resolves.toBe('team-a')
    await expect(
      assertAgentChangeSetWorkspace('local-personal', [null, 'team'], dependencies)
    ).rejects.toThrow('agent-change-session-workspace-mismatch')
    await expect(
      assertAgentChangeSetWorkspace('team-a', ['team', 'personal'], dependencies)
    ).rejects.toThrow('agent-change-session-workspace-mismatch')
  })
})
