import { describe, expect, it } from 'vitest'
import { authorizeSshWorkspace } from '../../src/main/ssh/ssh-workspace-authorization'

describe('SSH workspace authorization', () => {
  const available = async (): Promise<ReadonlySet<string>> => new Set(['team-a'])

  it('keeps legacy requests local and accepts only offline-authorized teams', async () => {
    await expect(authorizeSshWorkspace(undefined, available)).resolves.toBe('local-personal')
    await expect(authorizeSshWorkspace('team-a', available)).resolves.toBe('team-a')
    await expect(authorizeSshWorkspace('team-b', available)).rejects.toThrow(
      'SSH_WORKSPACE_UNAVAILABLE'
    )
  })

  it('rejects malformed or ambiguous workspace IDs', async () => {
    for (const invalid of [null, '', ' team-a', 'team-a ', 123, 'a'.repeat(1025)])
      await expect(authorizeSshWorkspace(invalid, available)).rejects.toThrow(
        'SSH_WORKSPACE_UNAVAILABLE'
      )
  })
})
