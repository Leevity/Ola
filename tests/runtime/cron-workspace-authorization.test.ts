import { expect, it, vi } from 'vitest'
import { authorizeCronWorkspace } from '../../src/main/ipc/cron-workspace-authorization'

it('requires an explicit workspace matching the registered window', async () => {
  const available = vi.fn(async () => new Set(['team-a']))
  await expect(authorizeCronWorkspace(undefined, 'local-personal', available)).rejects.toThrow(
    'db-workspace-required'
  )
  await expect(
    authorizeCronWorkspace({ workspaceId: 'team-a' }, 'local-personal', available)
  ).rejects.toThrow('cron-workspace-mismatch')
  await expect(
    authorizeCronWorkspace({ workspaceId: 'team-a' }, 'team-a', available)
  ).resolves.toBe('team-a')
})

it('rejects a revoked team workspace before routing to either read backend', async () => {
  await expect(
    authorizeCronWorkspace({ workspaceId: 'team-a' }, 'team-a', async () => new Set())
  ).rejects.toThrow('db-workspace-unavailable')
})
