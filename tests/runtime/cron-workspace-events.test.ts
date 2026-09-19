import { expect, it, vi } from 'vitest'

const send = vi.hoisted(() => vi.fn())
vi.mock('../../src/main/window-ipc', () => ({
  safeSendMessagePackToWorkspaceWindows: send
}))

import { sendCronWorkspaceEvent } from '../../src/main/cron/cron-workspace-events'
import { isCronWorkspaceEventFor } from '../../src/renderer/src/lib/cron-workspace-event'

it('routes Cron events only to registered windows of their workspace and stamps the payload', () => {
  sendCronWorkspaceEvent('team-a', 'cron:fired', {
    jobId: 'team-job',
    prompt: 'private task'
  })
  expect(send).toHaveBeenCalledWith('team-a', 'cron:fired', {
    jobId: 'team-job',
    prompt: 'private task',
    workspaceId: 'team-a'
  })
})

it('rejects missing and stale-workspace Cron events in the renderer', () => {
  expect(isCronWorkspaceEventFor({ workspaceId: 'team-a' }, 'team-a')).toBe(true)
  expect(isCronWorkspaceEventFor({ workspaceId: 'team-a' }, 'team-b')).toBe(false)
  expect(isCronWorkspaceEventFor({ jobId: 'old-job' }, 'team-a')).toBe(false)
  expect(isCronWorkspaceEventFor(null, 'team-a')).toBe(false)
})
