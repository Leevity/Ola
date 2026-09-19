import { describe, expect, it } from 'vitest'
import { resolveAuthorizedAgentRunWorkspace } from '../../src/main/ipc/agent-run-workspace'

describe('Agent run workspace admission', () => {
  it('uses persisted session ownership before Goal or Agent preparation', async () => {
    const dependencies = {
      sessionWorkspace: async () => 'team-a',
      availableWorkspaceIds: async () => new Set(['team-a'])
    }
    await expect(
      resolveAuthorizedAgentRunWorkspace('session-a', 'team-a', dependencies)
    ).resolves.toBe('team-a')
    await expect(
      resolveAuthorizedAgentRunWorkspace('session-a', 'local-personal', dependencies)
    ).rejects.toThrow('SESSION_WORKSPACE_MISMATCH')
  })

  it('rejects a revoked team while leaving local personal offline-capable', async () => {
    const team = {
      sessionWorkspace: async () => 'team-a',
      availableWorkspaceIds: async () => new Set<string>()
    }
    await expect(resolveAuthorizedAgentRunWorkspace('session-a', null, team)).rejects.toThrow(
      'SSH_WORKSPACE_UNAVAILABLE'
    )
    await expect(
      resolveAuthorizedAgentRunWorkspace('session-b', 'local-personal', {
        ...team,
        sessionWorkspace: async () => 'local-personal'
      })
    ).resolves.toBe('local-personal')
  })
})
