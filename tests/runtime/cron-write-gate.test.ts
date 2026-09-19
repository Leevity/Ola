import { describe, expect, it, vi } from 'vitest'
import type { CronJobRecord } from '../../src/main/db/cron-dao'

const state = vi.hoisted(() => ({
  calls: [] as string[],
  params: [] as unknown[],
  resolve: null as ((value: { success: boolean }) => void) | null
}))

vi.mock('../../src/main/lib/native-worker', () => ({
  getNativeWorker: () => ({
    request: (method: string, params: unknown) => {
      state.calls.push(method)
      state.params.push(params)
      return new Promise((resolve) => {
        state.resolve = resolve
      })
    }
  })
}))

import { createCronJob, updateCronJob } from '../../src/main/db/cron-dao'
import { quiesceCronWritesForHandover } from '../../src/main/cron/cron-write-gate'

describe('Cron DAO handover write barrier', () => {
  it('tracks a Native mutation until it settles and rejects later writes', async () => {
    const job = { id: 'job-a', workspace_id: 'team-a' } as CronJobRecord
    const pending = createCronJob(job)
    await Promise.resolve()
    expect(state.calls).toEqual(['db/cron-jobs-create'])
    expect(state.params[0]).toEqual({ job, workspaceId: 'team-a' })
    expect(quiesceCronWritesForHandover).toThrow('CRON_WRITES_ACTIVE_DURING_HANDOVER')
    await expect(updateCronJob(job)).rejects.toThrow('CRON_WRITES_QUIESCING')
    expect(state.calls).toEqual(['db/cron-jobs-create'])
    state.resolve?.({ success: true })
    await pending
    expect(quiesceCronWritesForHandover).not.toThrow()
  })
})
