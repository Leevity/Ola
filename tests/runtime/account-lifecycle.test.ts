import { describe, expect, it } from 'vitest'
import {
  notifyRemoteAccountCleared,
  notifyWorkspaceDirectoryChanged,
  onRemoteAccountCleared,
  onWorkspaceDirectoryChanged
} from '../../src/main/remote/account-lifecycle'

describe('remote account lifecycle cleanup', () => {
  it('waits for every cleanup and isolates a failing listener', async () => {
    const calls: string[] = []
    const offFirst = onRemoteAccountCleared(async () => {
      await Promise.resolve()
      calls.push('first')
    })
    const offFailure = onRemoteAccountCleared(() => {
      throw new Error('cleanup failed')
    })
    const offLast = onRemoteAccountCleared(() => {
      calls.push('last')
    })
    try {
      await expect(notifyRemoteAccountCleared()).resolves.toBeUndefined()
      expect(calls).toEqual(['last', 'first'])
    } finally {
      offFirst()
      offFailure()
      offLast()
    }
  })

  it('delivers refreshed workspace authorization to registered cleanup listeners', async () => {
    const seen: string[][] = []
    const off = onWorkspaceDirectoryChanged((ids) => {
      seen.push([...ids])
    })
    try {
      await notifyWorkspaceDirectoryChanged(new Set(['team-a']))
      expect(seen).toEqual([['team-a']])
    } finally {
      off()
    }
  })
})
