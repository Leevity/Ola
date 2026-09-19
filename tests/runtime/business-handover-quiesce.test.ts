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
vi.mock('../../src/main/ipc/native-agent-runtime', () => ({
  getNativeAgentRuntimeManager: () => ({
    quiesceForHandover: async () => {
      state.calls.push('agent')
      if (state.failAt === 'agent') throw new Error('NATIVE_AGENT_RUNS_ACTIVE_DURING_HANDOVER')
    }
  })
}))
vi.mock('../../src/main/lib/native-worker', () => ({
  parkNativeWorkerForHandover: async () => {
    state.calls.push('worker')
    if (state.failAt === 'worker') throw new Error('NATIVE_WORKER_REQUEST_DRAIN_TIMEOUT')
  }
}))

import { quiesceDesktopLegacyBusinessWriter } from '../../src/main/runtime/business-handover-quiesce'

beforeEach(() => {
  state.calls = []
  state.failAt = ''
})

it('quiesces channels, scheduled runs, sync and Agent admissions before parking the Worker', async () => {
  await quiesceDesktopLegacyBusinessWriter()
  expect(state.calls).toEqual(['channels', 'cron', 'sync', 'agent', 'worker'])
})

it.each([
  ['channels', ['channels']],
  ['cron', ['channels', 'cron']],
  ['sync', ['channels', 'cron', 'sync']],
  ['agent', ['channels', 'cron', 'sync', 'agent']],
  ['worker', ['channels', 'cron', 'sync', 'agent', 'worker']]
])('does not advance past a failed %s gate', async (failed, calls) => {
  state.failAt = failed
  await expect(quiesceDesktopLegacyBusinessWriter()).rejects.toThrow()
  expect(state.calls).toEqual(calls)
})
