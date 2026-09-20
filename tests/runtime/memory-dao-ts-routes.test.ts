import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const repository: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const method of [
    'recordMemoryAutomationEntry',
    'memoryAutomationEntry',
    'memoryAutomationEntries',
    'markMemoryAutomationUndo',
    'memoryRollups',
    'markMemoryRollup',
    'ensureMemoryRoot',
    'memoryRoot',
    'memoryRoots',
    'createMemoryJob',
    'memoryJob',
    'finishMemoryJob',
    'memoryJobs',
    'addMemoryStage1Output',
    'memoryStage1Outputs',
    'recordMemoryCitationUsage',
    'clearMemoryRoot'
  ])
    repository[method] = vi.fn()
  return { repository, routeGuard: vi.fn() }
})

vi.mock('../../src/main/db/business-write-canary', () => ({
  businessWriteCanary: () => state.repository,
  getTsDatabaseRouteGuard: () => {
    state.routeGuard()
    throw new Error('memory DAO unexpectedly entered the legacy route guard')
  }
}))

import {
  addMemoryAutomationEntry,
  getMemoryAutomationEntry,
  listMemoryAutomationEntries,
  markMemoryAutomationUndo,
  hasProcessedRollup,
  markProcessedRollup
} from '../../src/main/db/memory-automation-dao'
import {
  addStage1Output,
  clearMemoryRoot,
  createMemoryJob,
  ensureMemoryRoot,
  finishMemoryJob,
  getMemoryJob,
  getMemoryRoot,
  listMemoryJobs,
  listMemoryRoots,
  listStage1Outputs,
  recordCitationUsage
} from '../../src/main/db/memory-pipeline-dao'

beforeEach(() => {
  for (const method of Object.values(state.repository)) method.mockReset()
  state.routeGuard.mockReset()
  state.repository.recordMemoryAutomationEntry.mockResolvedValue({ id: 'entry-1' })
  state.repository.memoryAutomationEntry.mockResolvedValue({ id: 'entry-1' })
  state.repository.memoryAutomationEntries.mockResolvedValue([{ id: 'entry-1' }])
  state.repository.markMemoryAutomationUndo.mockResolvedValue({ id: 'entry-1' })
  state.repository.memoryRollups.mockResolvedValue([])
  state.repository.markMemoryRollup.mockResolvedValue(undefined)
  state.repository.ensureMemoryRoot.mockResolvedValue({ id: 'root-1' })
  state.repository.memoryRoot.mockResolvedValue({ id: 'root-1' })
  state.repository.memoryRoots.mockResolvedValue([{ id: 'root-1' }])
  state.repository.createMemoryJob.mockResolvedValue({ id: 'job-1' })
  state.repository.memoryJob.mockResolvedValue({ id: 'job-1' })
  state.repository.finishMemoryJob.mockResolvedValue({ id: 'job-1' })
  state.repository.memoryJobs.mockResolvedValue([{ id: 'job-1' }])
  state.repository.addMemoryStage1Output.mockResolvedValue({ id: 'stage-1' })
  state.repository.memoryStage1Outputs.mockResolvedValue([{ id: 'stage-1' }])
  state.repository.recordMemoryCitationUsage.mockResolvedValue(undefined)
  state.repository.clearMemoryRoot.mockResolvedValue({ deletedStage1Outputs: 1, deletedJobs: 1 })
})

describe('memory DAO TS route ownership', () => {
  it('keeps automation, rollup, root, job, stage and citation routes on the TS repository', async () => {
    const input = {
      workspaceId: 'team-a',
      scope: 'main' as const,
      target: 'project_memory' as const,
      kind: 'project_decision' as const,
      content: 'content',
      fingerprint: 'fingerprint',
      status: 'written' as const
    }
    await addMemoryAutomationEntry(input)
    await getMemoryAutomationEntry('entry-1', 'team-a')
    await listMemoryAutomationEntries({ workspaceId: 'team-a' })
    await markMemoryAutomationUndo('entry-1', 'undone', null, 'team-a')
    await hasProcessedRollup({
      workspaceId: 'team-a',
      scope: 'main',
      targetPath: 'memory.md',
      sourceDate: '2026-09-20',
      contentHash: 'hash'
    })
    await markProcessedRollup({
      workspaceId: 'team-a',
      scope: 'main',
      target: 'project_memory',
      targetPath: 'memory.md',
      sourceDate: '2026-09-20',
      contentHash: 'hash'
    })

    await ensureMemoryRoot({ workspaceId: 'team-a', scope: 'project', rootPath: '/tmp/memory' })
    await getMemoryRoot('root-1', 'team-a')
    await listMemoryRoots({ workspaceId: 'team-a' })
    await createMemoryJob({ kind: 'stage1', workspaceId: 'team-a' })
    await getMemoryJob('job-1', 'team-a')
    await finishMemoryJob({ id: 'job-1', workspaceId: 'team-a', status: 'succeeded' })
    await listMemoryJobs({ workspaceId: 'team-a' })
    await addStage1Output({
      memoryRootId: 'root-1',
      workspaceId: 'team-a',
      scope: 'project',
      sourceSessionId: 'session-a',
      rawMemory: 'content',
      rolloutSummary: 'summary',
      rolloutSlug: 'summary',
      fingerprint: 'fingerprint'
    })
    await listStage1Outputs({ memoryRootId: 'root-1', workspaceId: 'team-a' })
    await recordCitationUsage({
      workspaceId: 'team-a',
      memoryRootId: 'root-1',
      scope: 'project',
      path: 'src/index.ts'
    })
    await clearMemoryRoot({ memoryRootId: 'root-1', workspaceId: 'team-a', includeJobs: true })

    expect(state.routeGuard).not.toHaveBeenCalled()
    expect(state.repository.recordMemoryAutomationEntry).toHaveBeenCalled()
    expect(state.repository.ensureMemoryRoot).toHaveBeenCalled()
    expect(state.repository.clearMemoryRoot).toHaveBeenCalled()
  })
})
