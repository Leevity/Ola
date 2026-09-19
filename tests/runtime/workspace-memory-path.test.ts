import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  workspaceMemoryDataRoot,
  workspaceMemoryHome
} from '../../src/main/lib/workspace-memory-path'

describe('workspace global memory home', () => {
  it('preserves the legacy personal path and gives managed spaces distinct safe paths', () => {
    const userHome = path.join(path.sep, 'users', 'ola')
    expect(workspaceMemoryHome(userHome, 'local-personal')).toBe(path.join(userHome, '.ola'))
    const teamA = workspaceMemoryHome(userHome, 'team-a')
    const teamB = workspaceMemoryHome(userHome, 'team-b')
    expect(teamA).toBe(
      path.join(userHome, '.ola', 'workspaces', createHash('sha256').update('team-a').digest('hex'))
    )
    expect(teamA).not.toBe(teamB)
    expect(workspaceMemoryHome(userHome, '../team-a')).not.toContain('..')
    expect(() => workspaceMemoryHome(userHome, '')).toThrow('Invalid memory workspace')
  })

  it('uses an explicit Ola data root without changing the personal and team layout', () => {
    const dataRoot = path.join(path.sep, 'isolated', 'ola-data')
    expect(workspaceMemoryDataRoot(dataRoot, 'local-personal')).toBe(dataRoot)
    expect(workspaceMemoryDataRoot(dataRoot, 'team-a')).toBe(
      path.join(dataRoot, 'workspaces', createHash('sha256').update('team-a').digest('hex'))
    )
  })
})
