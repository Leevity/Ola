import { describe, expect, it } from 'vitest'
import {
  cachedWorkspaceExpiresAt,
  cachedWorkspaceDirectory,
  isOfflineTransportError,
  OFFLINE_WORKSPACE_CACHE_MAX_AGE_MS
} from '../../src/main/remote/offline-workspace-cache'

const snapshot = {
  accountId: 'account-a',
  apiBaseUrl: 'https://example.test',
  fetchedAt: 1_000_000,
  directory: {
    workspaces: [
      {
        id: 'team-a',
        kind: 'team' as const,
        name: 'Team A',
        role: 'member' as const,
        revision: undefined
      }
    ]
  }
}

describe('offline workspace directory boundary', () => {
  it('returns a recent, account-bound public directory', () => {
    expect(cachedWorkspaceExpiresAt('account-a', snapshot.apiBaseUrl, snapshot, 1_000_001)).toBe(
      snapshot.fetchedAt + OFFLINE_WORKSPACE_CACHE_MAX_AGE_MS + 1
    )
    expect(cachedWorkspaceExpiresAt('account-b', snapshot.apiBaseUrl, snapshot)).toBeNull()
    expect(cachedWorkspaceDirectory('account-a', snapshot.apiBaseUrl, snapshot, 1_000_001)).toEqual(
      snapshot.directory
    )
    expect(
      cachedWorkspaceDirectory('account-b', snapshot.apiBaseUrl, snapshot, 1_000_001)
    ).toBeNull()
    expect(
      cachedWorkspaceDirectory('account-a', 'https://other.test', snapshot, 1_000_001)
    ).toBeNull()
    expect(cachedWorkspaceDirectory('account-a', snapshot.apiBaseUrl, snapshot, 999_999)).toBeNull()
    expect(
      cachedWorkspaceDirectory(
        'account-a',
        snapshot.apiBaseUrl,
        snapshot,
        snapshot.fetchedAt + OFFLINE_WORKSPACE_CACHE_MAX_AGE_MS + 1
      )
    ).toBeNull()
  })

  it('only treats transport failures as offline, not explicit authorization rejection', () => {
    expect(isOfflineTransportError(new TypeError('fetch failed'))).toBe(true)
    expect(
      isOfflineTransportError(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))
    ).toBe(true)
    expect(isOfflineTransportError(new Error('Unauthorized'))).toBe(false)
  })
})
