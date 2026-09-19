import { expect, it, vi } from 'vitest'
import type { CronJobRecord } from '../../src/main/db/cron-dao'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../src/main/window-ipc', () => ({
  safeSendMessagePackToAllWindows: vi.fn(),
  safeSendMessagePackToWindow: vi.fn()
}))
vi.mock('../../src/main/db/cron-dao', () => ({
  createCronRun: vi.fn(),
  getCronRun: vi.fn(),
  loadPersistedCronJobs: vi.fn(),
  markCronJobFired: vi.fn(),
  softDeleteCronJob: vi.fn(),
  updateCronRun: vi.fn()
}))
vi.mock('../../src/main/cron/cron-agent-background', () => ({
  runCronAgentInBackground: vi.fn()
}))
vi.mock('../../src/main/cron/ts-cron-agent-background', () => ({
  runTsCronAgentInBackground: vi.fn()
}))
vi.mock('../../src/main/runtime/desktop-runtime', () => ({
  desktopRuntime: { isAvailable: false }
}))

import { createCronRun } from '../../src/main/db/cron-dao'
import {
  beginCronWorkspaceSwitch,
  isCronWorkspaceSwitchPending,
  markFinished,
  markRunning,
  recordSkippedCronRun
} from '../../src/main/cron/cron-scheduler'

it('keeps Cron admissions and skipped-run writes closed until the switch releases', async () => {
  const release = beginCronWorkspaceSwitch()
  expect(isCronWorkspaceSwitchPending()).toBe(true)
  expect(markRunning('late-job')).toBe(false)
  expect(() => beginCronWorkspaceSwitch()).toThrow('WORKSPACE_BUSY_CRON')
  await expect(recordSkippedCronRun({ id: 'late-job' } as CronJobRecord)).rejects.toThrow(
    'WORKSPACE_BUSY_CRON'
  )
  expect(createCronRun).not.toHaveBeenCalled()
  release()
  release()
  expect(isCronWorkspaceSwitchPending()).toBe(false)
  expect(markRunning('next-job')).toBe(true)
  expect(() => beginCronWorkspaceSwitch()).toThrow('WORKSPACE_BUSY_CRON')
  await markFinished('next-job')
})
