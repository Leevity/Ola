import { describe, expect, it } from 'vitest'
import { sshSessionsForConnection } from '../../src/main/ssh/ssh-session-scope'

describe('SSH connection session scope', () => {
  it('does not select another workspace session with the same connection ID', () => {
    const sessions = new Map([
      ['personal', { connectionId: 'shared-id', workspaceId: 'local-personal' }],
      ['team-a', { connectionId: 'shared-id', workspaceId: 'team-a' }],
      ['team-b', { connectionId: 'shared-id', workspaceId: 'team-b' }],
      ['team-a-other', { connectionId: 'other-id', workspaceId: 'team-a' }]
    ])

    expect(sshSessionsForConnection(sessions, 'shared-id', 'team-a')).toEqual([
      ['team-a', sessions.get('team-a')]
    ])
    expect(sshSessionsForConnection(sessions, 'shared-id', 'local-personal')).toEqual([
      ['personal', sessions.get('personal')]
    ])
  })
})
