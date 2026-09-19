import { describe, expect, it, vi } from 'vitest'
import { revokeUnavailableWorkspaceResources } from '../../src/main/ssh/ssh-workspace-revocation'

describe('SSH workspace resource revocation', () => {
  it('stops revoked team resources while preserving personal and authorized teams', async () => {
    const resources = new Map([
      ['personal', { workspaceId: 'local-personal' }],
      ['allowed', { workspaceId: 'team-a' }],
      ['revoked', { workspaceId: 'team-b' }]
    ])
    const stop = vi.fn(async () => undefined)
    await revokeUnavailableWorkspaceResources(resources, new Set(['team-a']), stop)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(resources.has('personal')).toBe(true)
    expect(resources.has('allowed')).toBe(true)
    expect(resources.has('revoked')).toBe(false)
  })

  it('retains failed resources for retry and never deletes a replacement with the same ID', async () => {
    const failed = { workspaceId: 'team-b' }
    const resources = new Map([['task', failed]])
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await revokeUnavailableWorkspaceResources(resources, new Set(), () => {
        throw new Error('abort failed')
      })
      expect(resources.get('task')).toBe(failed)
      await revokeUnavailableWorkspaceResources(resources, new Set(), () => {
        resources.set('task', { workspaceId: 'team-b' })
      })
      expect(resources.has('task')).toBe(true)
    } finally {
      warning.mockRestore()
    }
  })
})
