import { describe, expect, it, vi } from 'vitest'
import type { CronJobRecord } from '../../src/main/db/cron-dao'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../src/main/window-ipc', () => ({
  safeSendMessagePackToAllWindows: vi.fn(),
  safeSendMessagePackToWindow: vi.fn()
}))
vi.mock('../../src/main/db/cron-dao', () => ({
  createCronRun: vi.fn(),
  getCronJob: vi.fn(),
  getCronRun: vi.fn(),
  loadPersistedCronJobs: vi.fn(),
  softDeleteCronJob: vi.fn(),
  updateCronRun: vi.fn()
}))
vi.mock('../../src/main/cron/ts-cron-agent-background', () => ({
  runTsCronAgentInBackground: vi.fn()
}))

import {
  cancelAllJobs,
  getActiveRunJobIds,
  getScheduledJobIds,
  markFinished,
  markRunning,
  quiesceCronSchedulerForHandover,
  scheduleJob
} from '../../src/main/cron/cron-scheduler'
import { getCronJob } from '../../src/main/db/cron-dao'
import { runTsCronAgentInBackground } from '../../src/main/cron/ts-cron-agent-background'
import { guardedCronWrite } from '../../src/main/cron/cron-write-gate'

describe('Cron handover quiescence', () => {
  it('does not execute a queued scheduled callback after the job is disabled', async () => {
    vi.useFakeTimers()
    const job = {
      id: 'disabled-race-job',
      workspace_id: 'local-personal',
      enabled: 1,
      deleted_at: null,
      schedule_kind: 'at',
      schedule_at: Date.now() + 100
    } as CronJobRecord
    vi.mocked(getCronJob).mockResolvedValue({ ...job, enabled: 0 })

    expect(scheduleJob(job)).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()

    expect(getCronJob).toHaveBeenCalledWith(job.id, 'local-personal')
    expect(runTsCronAgentInBackground).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('stops future fires but refuses handover until active runs settle', async () => {
    const job = {
      id: 'handover-job',
      schedule_kind: 'at',
      schedule_at: Date.now() + 60_000
    } as CronJobRecord
    expect(scheduleJob(job)).toBe(true)
    expect(markRunning(job.id)).toBe(true)
    cancelAllJobs()
    expect(getScheduledJobIds()).toEqual([])
    expect(getActiveRunJobIds()).toEqual([job.id])
    expect(quiesceCronSchedulerForHandover).toThrow('CRON_RUNS_ACTIVE_DURING_HANDOVER')
    await expect(guardedCronWrite(async () => 'existing run may finish')).resolves.toBe(
      'existing run may finish'
    )
    expect(scheduleJob(job)).toBe(false)
    expect(markRunning('late-job')).toBe(false)
    const finishing = markFinished(job.id)
    expect(quiesceCronSchedulerForHandover).toThrow('CRON_RUNS_ACTIVE_DURING_HANDOVER')
    await finishing
    expect(getActiveRunJobIds()).toEqual([])
    expect(quiesceCronSchedulerForHandover).not.toThrow()
  })
})
