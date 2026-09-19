import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/lib/native-worker', () => ({ getNativeWorker: vi.fn() }))

const readState = vi.hoisted(() => ({
  calls: 0,
  releaseFirst: null as (() => void) | null,
  firstStarted: null as (() => void) | null
}))

vi.mock('../../src/main/ssh/ssh-config-json', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/ssh/ssh-config-json')>()
  return {
    ...original,
    readSshConfigDocument: async () => {
      readState.calls += 1
      if (readState.calls === 1) {
        readState.firstStarted?.()
        await new Promise<void>((resolve) => {
          readState.releaseFirst = resolve
        })
      }
      return { groups: [{ id: 'team', name: 'Team', sortOrder: 0, createdAt: 1, updatedAt: 1 }] }
    }
  }
})

import {
  forgetUnavailableSshConfigCaches,
  initializeSshConfigCache,
  listSshGroups,
  withSshWorkspace
} from '../../src/main/ssh/ssh-config'

describe('SSH configuration revocation race', () => {
  it('does not restore a revoked cache or remove a newer initialization', async () => {
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    readState.firstStarted = firstStarted

    const first = withSshWorkspace('team-race', () => initializeSshConfigCache())
    await started
    forgetUnavailableSshConfigCaches(new Set())
    await withSshWorkspace('team-race', () => initializeSshConfigCache())
    readState.releaseFirst?.()
    await first

    expect(readState.calls).toBe(2)
    expect(withSshWorkspace('team-race', () => listSshGroups().map((group) => group.id))).toEqual([
      'team'
    ])
  })
})
