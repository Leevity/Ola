import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  scopes: [] as string[],
  fail: false,
  closed: 0,
  nativeScopes: [] as string[]
}))

vi.mock('../../src/main/db/database', () => ({ getDataDir: () => '/unused' }))
vi.mock('../../src/main/lib/native-worker', () => ({
  getNativeWorker: () => ({
    request: async (_route: string, args: { workspaceId: string }) => {
      state.nativeScopes.push(args.workspaceId)
      return [
        JSON.stringify({
          id: 'native-flow',
          workspaceId: args.workspaceId,
          name: 'Native',
          steps: []
        })
      ]
    }
  })
}))
vi.mock('../../src/runtime/storage/legacy-read-repository', () => ({
  LegacyReadRepository: class {
    async desktopFlows(workspaceId: string) {
      state.scopes.push(workspaceId)
      if (state.fail) throw new Error('read failed')
      return [JSON.stringify({ id: 'flow-a', workspaceId, name: 'Flow', steps: [] })]
    }
    async close() {
      state.closed++
    }
  }
}))

import { canaryListDesktopFlows, closeLegacyReadCanary } from '../../src/main/db/legacy-read-canary'
import { listPersistedDesktopFlows } from '../../src/main/db/capability-dao'

afterEach(async () => {
  await closeLegacyReadCanary()
  delete process.env.OLA_TS_DESKTOP_FLOW_READS
  delete process.env.OLA_TS_LEGACY_READ_PATH
  state.scopes = []
  state.fail = false
  state.closed = 0
  state.nativeScopes = []
})

it('uses the default TS desktop flow reader and falls back after a read failure', async () => {
  process.env.OLA_TS_LEGACY_READ_PATH = '/unused/native.db'
  await expect(canaryListDesktopFlows('team-a')).resolves.toEqual([
    JSON.stringify({ id: 'flow-a', workspaceId: 'team-a', name: 'Flow', steps: [] })
  ])
  expect(state.scopes).toEqual(['team-a'])
  process.env.OLA_TS_DESKTOP_FLOW_READS = '0'
  await expect(canaryListDesktopFlows('team-a')).resolves.toBeUndefined()
  expect(state.scopes).toEqual(['team-a'])
  delete process.env.OLA_TS_DESKTOP_FLOW_READS
  state.fail = true
  await expect(canaryListDesktopFlows('team-a')).resolves.toBeUndefined()
  expect(state.closed).toBe(1)
})

it('routes Main desktop flow listing to TS by default and falls back to Native', async () => {
  process.env.OLA_TS_LEGACY_READ_PATH = '/unused/native.db'
  await expect(listPersistedDesktopFlows('team-a')).resolves.toMatchObject([{ id: 'flow-a' }])
  expect(state.nativeScopes).toEqual([])
  process.env.OLA_TS_DESKTOP_FLOW_READS = '0'
  await expect(listPersistedDesktopFlows('team-a')).resolves.toMatchObject([{ id: 'native-flow' }])
  expect(state.nativeScopes).toEqual(['team-a'])
  delete process.env.OLA_TS_DESKTOP_FLOW_READS
  state.fail = true
  await expect(listPersistedDesktopFlows('team-a')).resolves.toMatchObject([{ id: 'native-flow' }])
  expect(state.nativeScopes).toEqual(['team-a', 'team-a'])
})
