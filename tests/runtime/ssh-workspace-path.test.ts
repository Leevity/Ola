import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { sshWorkspaceConfigPath } from '../../src/main/ssh/ssh-workspace-path'

describe('SSH workspace configuration paths', () => {
  it('preserves the existing local-personal file and separates managed workspaces', () => {
    const home = join('/tmp', 'ola-ssh-workspace-path')
    const personal = sshWorkspaceConfigPath(home, 'local-personal')
    const teamA = sshWorkspaceConfigPath(home, 'team-a')
    const teamB = sshWorkspaceConfigPath(home, 'team-b')
    expect(personal).toBe(join(home, '.ola.json'))
    expect(teamA).not.toBe(personal)
    expect(teamA).not.toBe(teamB)
    expect(teamA).toMatch(/\.ola[/\\]workspaces[/\\][a-f0-9]{64}[/\\]ssh\.json$/)
    expect(() => sshWorkspaceConfigPath(home, '../escape')).not.toThrow()
    expect(sshWorkspaceConfigPath(home, '../escape')).toMatch(/ssh\.json$/)
    expect(sshWorkspaceConfigPath(home, 'team-a', join('/tmp', 'isolated-ola'))).toMatch(
      /isolated-ola[/\\]workspaces[/\\][a-f0-9]{64}[/\\]ssh\.json$/
    )
  })
})
