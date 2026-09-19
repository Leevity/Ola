import { describe, expect, it, vi } from 'vitest'
import { authorizeMessageSearchWorkspace } from '../../src/main/ipc/message-search-workspace'

describe('message search workspace authorization', () => {
  it('requires an explicit canonical workspace and allows local personal offline', async () => {
    const available = vi.fn(async () => new Set<string>())
    await expect(authorizeMessageSearchWorkspace(undefined, available)).rejects.toThrow(
      'message-search-workspace-required'
    )
    await expect(authorizeMessageSearchWorkspace(' team-a ', available)).rejects.toThrow(
      'message-search-workspace-required'
    )
    await expect(authorizeMessageSearchWorkspace('local-personal', available)).resolves.toBe(
      'local-personal'
    )
    expect(available).not.toHaveBeenCalled()
  })

  it('rechecks offline team membership before results are returned', async () => {
    let authorized = true
    const available = vi.fn(async () => new Set(authorized ? ['team-a'] : []))
    await expect(authorizeMessageSearchWorkspace('team-a', available)).resolves.toBe('team-a')
    authorized = false
    await expect(authorizeMessageSearchWorkspace('team-a', available)).rejects.toThrow(
      'message-search-workspace-unavailable'
    )
  })
})
