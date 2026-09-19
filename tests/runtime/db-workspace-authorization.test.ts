import { describe, expect, it, vi } from 'vitest'
import { authorizeDbWorkspace } from '../../src/main/ipc/db-workspace-authorization'

describe('database IPC workspace authorization', () => {
  it('requires a canonical explicit workspace for reads', async () => {
    const available = vi.fn(async () => new Set<string>())
    for (const invalid of [undefined, '', ' team-a ', 'x'.repeat(1025)]) {
      await expect(authorizeDbWorkspace(invalid, available)).rejects.toThrow(
        'db-workspace-required'
      )
    }
    await expect(authorizeDbWorkspace('local-personal', available)).resolves.toBe('local-personal')
    expect(available).not.toHaveBeenCalled()
  })

  it('rejects a team after its offline membership is revoked', async () => {
    let allowed = true
    const available = vi.fn(async () => new Set(allowed ? ['team-a'] : []))
    await expect(authorizeDbWorkspace('team-a', available)).resolves.toBe('team-a')
    allowed = false
    await expect(authorizeDbWorkspace('team-a', available)).rejects.toThrow(
      'db-workspace-unavailable'
    )
  })
})
