import { describe, expect, it, vi } from 'vitest'
import { permittedWorkspaceIds } from '../../src/main/runtime/workspace-authority'

describe('runtime workspace authority', () => {
  it('unions the local workspace with the account directory', async () => {
    const ids = await permittedWorkspaceIds(async () => new Set(['ola-personal-1', 'team-2']))
    expect([...ids].sort()).toEqual(['local-personal', 'ola-personal-1', 'team-2'])
  })

  it('keeps serving the local workspace when the directory read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // An expired or rejected account token throws out of the directory fetch; the local
      // workspace does not depend on that answer.
      const ids = await permittedWorkspaceIds(async () => {
        throw new Error('invalid token')
      })
      expect([...ids]).toEqual(['local-personal'])
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('workspace directory unavailable'),
        { error: 'invalid token' }
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('forbids hosted workspaces while the directory is unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const ids = await permittedWorkspaceIds(async () => {
        throw new TypeError('fetch failed')
      })
      expect(ids.has('ola-personal-1')).toBe(false)
      expect(ids.has('local-personal')).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('never drops the local workspace for an empty directory', async () => {
    expect(await permittedWorkspaceIds(async () => [])).toEqual(new Set(['local-personal']))
  })
})
