import { describe, expect, it } from 'vitest'
import {
  canSwitchToKnownWorkspace,
  hasActiveSshWorkspaceActivity
} from '../../src/renderer/src/lib/workspace-switch-eligibility'

describe('workspace switch eligibility', () => {
  it('allows the active workspace and current account-directory workspaces only', () => {
    expect(canSwitchToKnownWorkspace('local-personal', 'local-personal', [])).toBe(true)
    expect(canSwitchToKnownWorkspace('team-a', 'local-personal', ['team-a'])).toBe(true)
    expect(canSwitchToKnownWorkspace('revoked-team', 'local-personal', ['team-a'])).toBe(false)
  })

  it('blocks switching while SSH sessions, SFTP links or resumable transfers are active', () => {
    const idle = {
      sessions: {},
      sftpConnections: {},
      uploadTasks: {},
      transferTasks: {}
    }
    expect(hasActiveSshWorkspaceActivity(idle)).toBe(false)
    expect(
      hasActiveSshWorkspaceActivity({
        ...idle,
        sessions: { terminal: { status: 'reconnecting' } }
      })
    ).toBe(true)
    expect(
      hasActiveSshWorkspaceActivity({
        ...idle,
        sftpConnections: { connection: { status: 'connected' } }
      })
    ).toBe(true)
    expect(
      hasActiveSshWorkspaceActivity({
        ...idle,
        uploadTasks: { upload: { stage: 'cleanup' } }
      })
    ).toBe(true)
    expect(
      hasActiveSshWorkspaceActivity({
        ...idle,
        transferTasks: { transfer: { stage: 'paused' } }
      })
    ).toBe(true)
    expect(
      hasActiveSshWorkspaceActivity({
        sessions: { terminal: { status: 'disconnected' } },
        sftpConnections: { connection: { status: 'idle' } },
        uploadTasks: { upload: { stage: 'done' } },
        transferTasks: { transfer: { stage: 'canceled' } }
      })
    ).toBe(false)
  })
})
