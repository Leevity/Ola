import { describe, expect, it } from 'vitest'
import {
  getLayeredMemorySnapshot,
  loadLayeredMemorySnapshot,
  projectMemoryHomePath,
  resolveGlobalMemoryHomePath
} from '../../src/renderer/src/lib/agent/memory-files'
import type { IPCClient } from '../../src/renderer/src/lib/tools/tool-types'

describe('renderer memory home resolution', () => {
  it('does not guess the personal memory path when Main cannot resolve it', async () => {
    const calls: string[] = []
    const ipc = {
      invoke: async (channel: string) => {
        calls.push(channel)
        throw new Error('Main unavailable')
      },
      send: () => undefined,
      on: () => () => undefined
    } as IPCClient
    expect(await resolveGlobalMemoryHomePath(ipc, 'local-personal')).toBeUndefined()
    expect(calls).toEqual(['app:global-memory-home'])
  })

  it('requests the exact workspace and does not fall back to personal files on denial', async () => {
    const calls: unknown[] = []
    const ipc = {
      invoke: async (channel: string, payload?: unknown) => {
        calls.push({ channel, payload })
        if (channel === 'app:global-memory-home') {
          if ((payload as { workspaceId?: string })?.workspaceId === 'team-a')
            return '/managed/team-a'
          throw new Error('Memory workspace is not available')
        }
        return '/home/ola'
      },
      send: () => undefined,
      on: () => () => undefined
    } as IPCClient

    expect(await resolveGlobalMemoryHomePath(ipc, 'team-a')).toBe('/managed/team-a')
    expect(await resolveGlobalMemoryHomePath(ipc, 'team-b')).toBeUndefined()
    expect(calls).toEqual([
      { channel: 'app:global-memory-home', payload: { workspaceId: 'team-a' } },
      { channel: 'app:global-memory-home', payload: { workspaceId: 'team-b' } }
    ])
  })

  it('keeps team project memory out of the legacy shared project files', async () => {
    const key = 'a'.repeat(64)
    const readPaths: string[] = []
    const ipc = {
      invoke: async (channel: string, payload?: unknown) => {
        if (channel === 'app:global-memory-home') return `/home/ola/.ola/workspaces/${key}`
        if (channel === 'fs:read-file') {
          const path = (payload as { path: string }).path
          readPaths.push(path)
          if (path === '/repo/.agents/MEMORY.md') return 'legacy team secret'
          return { error: 'ENOENT' }
        }
        return undefined
      },
      on: () => () => undefined,
      send: () => undefined
    } as IPCClient
    expect(projectMemoryHomePath('/repo', 'team-a', `/home/ola/.ola/workspaces/${key}`)).toBe(
      `/repo/.agents/workspaces/${key}`
    )
    const snapshot = await loadLayeredMemorySnapshot(ipc, {
      workspaceId: 'team-a',
      workingFolder: '/repo',
      scope: 'main'
    })
    expect(snapshot.projectMemoryHomePath).toBe(`/repo/.agents/workspaces/${key}`)
    expect(snapshot.projectMemory).toBeUndefined()
    expect(readPaths).not.toContain('/repo/.agents/MEMORY.md')
    expect(readPaths).not.toContain('/repo/MEMORY.md')
  })

  it('does not publish a slower prior workspace load over the current workspace', async () => {
    let resolveFirst: ((path: string) => void) | undefined
    const ipc = {
      invoke: async (channel: string, payload?: unknown) => {
        if (channel === 'app:global-memory-home') {
          const workspaceId = (payload as { workspaceId: string }).workspaceId
          if (workspaceId === 'team-slow')
            return await new Promise<string>((resolve) => {
              resolveFirst = resolve
            })
          return '/managed/team-fast'
        }
        if (channel === 'fs:read-file') return { error: 'ENOENT' }
        return undefined
      },
      on: () => () => undefined,
      send: () => undefined
    } as IPCClient
    const slow = loadLayeredMemorySnapshot(ipc, { workspaceId: 'team-slow' })
    const fast = await loadLayeredMemorySnapshot(ipc, { workspaceId: 'team-fast' })
    resolveFirst?.('/managed/team-slow')
    const older = await slow
    expect(older.workspaceId).toBe('team-slow')
    expect(older.globalHomePath).toBe('/managed/team-slow')
    expect(fast.workspaceId).toBe('team-fast')
    expect(getLayeredMemorySnapshot().workspaceId).toBe('team-fast')
  })
})
