import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  workspaceId: 'local-personal',
  invoke: vi.fn()
}))

vi.mock('../../src/renderer/src/lib/ipc/ipc-client', () => ({
  ipcClient: { invoke: state.invoke }
}))
vi.mock('../../src/renderer/src/stores/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ activeWorkspaceId: state.workspaceId }) }
}))

import { useCronStore } from '../../src/renderer/src/stores/cron-store'

it('clears Cron data on workspace switch and discards late results from the old workspace', async () => {
  state.workspaceId = 'local-personal'
  useCronStore.getState().clearWorkspace()
  let finishJobs: (value: unknown) => void = () => undefined
  let finishRuns: (value: unknown) => void = () => undefined
  state.invoke.mockImplementation(
    (channel: string) =>
      new Promise((resolve) => {
        if (channel === 'cron:list') finishJobs = resolve
        else if (channel === 'cron:runs') finishRuns = resolve
      })
  )
  const jobs = useCronStore.getState().loadJobs()
  const runs = useCronStore.getState().loadRuns()
  state.workspaceId = 'team-a'
  useCronStore.getState().clearWorkspace()
  finishJobs([{ id: 'old-job' }])
  finishRuns([{ id: 'old-run' }])
  await Promise.all([jobs, runs])
  expect(useCronStore.getState().jobs).toEqual([])
  expect(useCronStore.getState().runs).toEqual([])

  state.invoke.mockResolvedValueOnce([{ id: 'team-job' }])
  await useCronStore.getState().loadJobs()
  expect(useCronStore.getState().jobs.map((job) => job.id)).toEqual(['team-job'])
})
