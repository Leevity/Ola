import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ calls: [] as string[], failAt: '' }))

vi.mock('../../src/main/channels/auto-reply', () => ({
  quiesceChannelsForHandover: async () => {
    state.calls.push('channels')
    if (state.failAt === 'channels') throw new Error('CHANNEL_HANDOVER_STOP_FAILED')
  }
}))
vi.mock('../../src/main/cron/cron-scheduler', () => ({
  quiesceCronSchedulerForHandover: () => {
    state.calls.push('cron')
    if (state.failAt === 'cron') throw new Error('CRON_RUNS_ACTIVE_DURING_HANDOVER')
  }
}))
vi.mock('../../src/main/ipc/sync-handlers', () => ({
  quiesceLegacySyncForHandover: async () => {
    state.calls.push('sync')
    if (state.failAt === 'sync') throw new Error('SYNC_RUNS_ACTIVE_DURING_HANDOVER')
  }
}))
import { quiesceDesktopLegacyBusinessWriter } from '../../src/main/runtime/business-handover-quiesce'

beforeEach(() => {
  state.calls = []
  state.failAt = ''
})

it('quiesces the remaining legacy writers before promoting TS ownership', async () => {
  await quiesceDesktopLegacyBusinessWriter()
  expect(state.calls).toEqual(['channels', 'cron', 'sync'])
})

it.each([
  ['channels', ['channels']],
  ['cron', ['channels', 'cron']],
  ['sync', ['channels', 'cron', 'sync']]
])('does not advance past a failed %s gate', async (failed, calls) => {
  state.failAt = failed
  await expect(quiesceDesktopLegacyBusinessWriter()).rejects.toThrow()
  expect(state.calls).toEqual(calls)
})
