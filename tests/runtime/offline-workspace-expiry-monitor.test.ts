import { afterEach, expect, it, vi } from 'vitest'
import { OfflineWorkspaceExpiryMonitor } from '../../src/main/runtime/offline-workspace-expiry-monitor'

afterEach(() => vi.useRealTimers())

it('revokes expired team access without waiting for another UI request', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  const revoked: string[][] = []
  const monitor = new OfflineWorkspaceExpiryMonitor(
    async () => 1_100,
    async () => {
      throw new TypeError('offline and cache expired')
    },
    (ids) => revoked.push([...ids])
  )
  try {
    monitor.refreshSchedule()
    await vi.advanceTimersByTimeAsync(99)
    expect(revoked).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(revoked).toEqual([[]])
  } finally {
    monitor.stop()
  }
})

it('revokes an expired directory once instead of re-reading it on a zero-delay timer', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  let reads = 0
  const revoked: string[][] = []
  const monitor = new OfflineWorkspaceExpiryMonitor(
    async () => 1_100,
    async () => {
      reads++
      return new Set(['team-a'])
    },
    (ids) => revoked.push([...ids])
  )
  try {
    monitor.refreshSchedule()
    await vi.advanceTimersByTimeAsync(100)
    expect(revoked).toEqual([['team-a']])
    // The cached directory stays expired, so re-arming on the same timestamp would fire
    // immediately and re-read (a network fetch plus a revocation) on every turn.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(revoked).toEqual([['team-a']])
    expect(reads).toBe(1)
  } finally {
    monitor.stop()
  }
})

it('rearms when an online refresh replaces the expiring directory', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  let expiresAt = 1_100
  const revoked: string[][] = []
  const monitor = new OfflineWorkspaceExpiryMonitor(
    async () => expiresAt,
    async () => {
      expiresAt = 1_300
      return new Set(['team-a'])
    },
    (ids) => revoked.push([...ids])
  )
  try {
    monitor.refreshSchedule()
    await vi.advanceTimersByTimeAsync(100)
    expect(revoked).toEqual([['team-a']])
    await vi.advanceTimersByTimeAsync(199)
    expect(revoked).toEqual([['team-a']])
    monitor.stop()
    await vi.advanceTimersByTimeAsync(1)
    expect(revoked).toEqual([['team-a']])
  } finally {
    monitor.stop()
  }
})
