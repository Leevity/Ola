import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ invoke: vi.fn(), workspaceId: 'team-a' }))
vi.mock('../../src/renderer/src/lib/ipc/ipc-client', () => ({
  ipcClient: { invoke: fixture.invoke }
}))
vi.mock('../../src/renderer/src/stores/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ activeWorkspaceId: fixture.workspaceId }) }
}))
import { useCronStore, type CronJobEntry } from '../../src/renderer/src/stores/cron-store'

const job = { id: 'job-a', workspaceId: 'team-a' } as CronJobEntry

describe('Cron store feedback and stale responses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fixture.workspaceId = 'team-a'
    useCronStore.getState().clearWorkspace()
  })

  it('preserves existing records on load failure and clears the error after recovery', async () => {
    useCronStore.setState({ jobs: [job] })
    fixture.invoke.mockResolvedValueOnce({ error: 'disk unavailable' })
    await useCronStore.getState().loadJobs()
    expect(useCronStore.getState().jobs).toEqual([job])
    expect(useCronStore.getState().jobsLoadError).toBe('CRON_LIST_UNAVAILABLE')
    fixture.invoke.mockResolvedValueOnce([])
    await useCronStore.getState().loadJobs()
    expect(useCronStore.getState().jobsLoadError).toBeNull()
    expect(useCronStore.getState().jobs).toEqual([])
    fixture.invoke.mockRejectedValueOnce(new Error('offline'))
    await useCronStore.getState().loadRuns()
    expect(useCronStore.getState().runsLoadError).toBe('offline')
  })

  it('ignores older refresh results and late responses from another workspace', async () => {
    let resolveOld!: (value: unknown) => void
    fixture.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    const old = useCronStore.getState().loadJobs()
    fixture.invoke.mockResolvedValueOnce([job])
    await useCronStore.getState().loadJobs()
    resolveOld([])
    await old
    expect(useCronStore.getState().jobs).toEqual([job])

    fixture.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    const pending = useCronStore.getState().loadJobs()
    fixture.workspaceId = 'team-b'
    useCronStore.getState().clearWorkspace()
    resolveOld([job])
    await pending
    expect(useCronStore.getState().jobs).toEqual([])
  })

  it('requires delete confirmation and does not delete same-id records after a space switch', async () => {
    useCronStore.setState({ jobs: [job] })
    fixture.invoke.mockResolvedValueOnce({ success: false })
    expect((await useCronStore.getState().deleteJob(job.id)).success).toBe(false)
    expect(useCronStore.getState().jobs).toEqual([job])
    let resolveDelete!: (value: unknown) => void
    fixture.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve
        })
    )
    const pending = useCronStore.getState().deleteJob(job.id)
    fixture.workspaceId = 'team-b'
    useCronStore.getState().clearWorkspace()
    const other = { ...job, workspaceId: 'team-b' }
    useCronStore.setState({ jobs: [other] })
    resolveDelete({ success: true })
    await pending
    expect(useCronStore.getState().jobs).toEqual([other])
  })
})
