import { describe, expect, it } from 'vitest'
import { SftpWorkspaceActivity } from '../../src/main/ssh/sftp-workspace-activity'

describe('SFTP workspace activity', () => {
  it('tracks pending and connected links across windows without dropping another owner', () => {
    const activity = new SftpWorkspaceActivity()
    const first = activity.beginConnect(1, 'shared')
    const second = activity.beginConnect(2, 'shared')
    expect(activity.hasActivity(() => true)).toBe(true)
    activity.finishConnect(first, true)
    activity.finishConnect(second, true)
    activity.disconnect(1, 'shared')
    expect(activity.hasActivity(() => true)).toBe(true)
    activity.disconnect(2, 'shared')
    expect(activity.hasActivity(() => true)).toBe(false)
  })

  it('ignores stale completions after disconnect and prunes closed windows', () => {
    const activity = new SftpWorkspaceActivity()
    const stale = activity.beginConnect(1, 'connection')
    activity.disconnect(1, 'connection')
    const current = activity.beginConnect(1, 'connection')
    activity.finishConnect(stale, true)
    activity.finishConnect(current, false)
    expect(activity.hasActivity(() => true)).toBe(false)

    const pending = activity.beginConnect(2, 'pending')
    expect(activity.hasActivity((windowId) => windowId !== 2)).toBe(false)
    activity.finishConnect(pending, true)
    expect(activity.hasActivity(() => true)).toBe(false)
  })

  it('holds activity until every concurrent connect settles and forgets deleted profiles', () => {
    const activity = new SftpWorkspaceActivity()
    const first = activity.beginConnect(3, 'connection')
    const second = activity.beginConnect(3, 'connection')
    activity.finishConnect(first, false)
    expect(activity.hasActivity(() => true)).toBe(true)
    activity.finishConnect(second, true)
    expect(activity.hasActivity(() => true)).toBe(true)
    activity.forgetConnection('connection')
    expect(activity.hasActivity(() => true)).toBe(false)
  })

  it('keeps same connection IDs separate and clears managed links after logout', () => {
    const activity = new SftpWorkspaceActivity()
    const personal = activity.beginConnect(1, 'shared')
    const team = activity.beginConnect(1, 'shared', 'team-a')
    activity.finishConnect(personal, true)
    activity.finishConnect(team, true)
    activity.forgetManagedWorkspaces()
    expect(activity.hasActivity(() => true)).toBe(true)
    activity.disconnect(1, 'shared')
    expect(activity.hasActivity(() => true)).toBe(false)
    activity.finishConnect(team, true)
    expect(activity.hasActivity(() => true)).toBe(false)
  })

  it('drops only workspaces revoked from a refreshed directory', () => {
    const activity = new SftpWorkspaceActivity()
    activity.finishConnect(activity.beginConnect(1, 'personal'), true)
    activity.finishConnect(activity.beginConnect(1, 'a', 'team-a'), true)
    const revoked = activity.beginConnect(1, 'b', 'team-b')
    activity.forgetUnavailableWorkspaces(new Set(['team-a']))
    activity.disconnect(1, 'personal')
    expect(activity.hasActivity(() => true)).toBe(true)
    activity.disconnect(1, 'a', 'team-a')
    expect(activity.hasActivity(() => true)).toBe(false)
    activity.finishConnect(revoked, true)
    expect(activity.hasActivity(() => true)).toBe(false)
  })
})
