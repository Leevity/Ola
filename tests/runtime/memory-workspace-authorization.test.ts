import { expect, it } from 'vitest'
import {
  authorizeMemoryWorkspace,
  handleMemoryWorkspaceRequest
} from '../../src/main/ipc/memory-workspace-authorization'

const available = async (): Promise<ReadonlySet<string>> => new Set(['team-a'])

it('requires a registered window in the requested memory workspace', async () => {
  await expect(authorizeMemoryWorkspace({}, 'local-personal', available)).resolves.toBe(
    'local-personal'
  )
  await expect(
    authorizeMemoryWorkspace({ workspaceId: 'team-a' }, 'team-a', available)
  ).resolves.toBe('team-a')
  await expect(authorizeMemoryWorkspace({}, 'team-a', available)).rejects.toThrow(
    'MEMORY_WINDOW_WORKSPACE_MISMATCH'
  )
  await expect(
    authorizeMemoryWorkspace({ workspaceId: 'team-a' }, 'local-personal', available)
  ).rejects.toThrow('MEMORY_WINDOW_WORKSPACE_MISMATCH')
  await expect(authorizeMemoryWorkspace({}, null, available)).rejects.toThrow(
    'MEMORY_WINDOW_WORKSPACE_MISMATCH'
  )
})

it('rejects unavailable and malformed team workspace identifiers', async () => {
  await expect(
    authorizeMemoryWorkspace({ workspaceId: 'team-b' }, 'team-b', available)
  ).rejects.toThrow('db-workspace-unavailable')
  await expect(
    authorizeMemoryWorkspace({ workspaceId: ' team-a ' }, 'team-a', available)
  ).rejects.toThrow('db-workspace-required')
  await expect(
    authorizeMemoryWorkspace({ workspaceId: null }, 'local-personal', available)
  ).rejects.toThrow('db-workspace-required')
})

it('does not release a result after the window switches or loses team authorization', async () => {
  let registered = 'team-a'
  let accessible = true
  const availability = async (): Promise<ReadonlySet<string>> =>
    new Set(accessible ? ['team-a'] : [])
  await expect(
    handleMemoryWorkspaceRequest(
      { workspaceId: 'team-a' },
      () => registered,
      availability,
      () => {
        registered = 'local-personal'
        return { secret: 'team memory' }
      }
    )
  ).rejects.toThrow('MEMORY_WINDOW_WORKSPACE_MISMATCH')
  registered = 'team-a'
  await expect(
    handleMemoryWorkspaceRequest(
      { workspaceId: 'team-a' },
      () => registered,
      availability,
      () => {
        accessible = false
        return { secret: 'team memory' }
      }
    )
  ).rejects.toThrow('db-workspace-unavailable')
})
