import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import {
  canaryGetMemoryRoot,
  canaryListMemoryRoots,
  canaryGetMemoryJob,
  canaryListMemoryJobs,
  canaryListMemoryStage1Outputs,
  closeLegacyReadCanary
} from '../../src/main/db/legacy-read-canary'
import type {
  MemoryPipelineListRootsQuery,
  MemoryPipelineListJobsQuery,
  MemoryPipelineJob,
  MemoryRootDescriptor,
  MemoryStage1Output
} from '../../src/shared/memory-automation-types'

const cleanup: Array<() => Promise<void>> = []
const originalPath = process.env.OLA_TS_LEGACY_READ_PATH
const originalEnabled = process.env.OLA_TS_MEMORY_ROOT_READS

afterEach(async () => {
  await closeLegacyReadCanary()
  if (originalPath === undefined) delete process.env.OLA_TS_LEGACY_READ_PATH
  else process.env.OLA_TS_LEGACY_READ_PATH = originalPath
  if (originalEnabled === undefined) delete process.env.OLA_TS_MEMORY_ROOT_READS
  else process.env.OLA_TS_MEMORY_ROOT_READS = originalEnabled
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('matches Native memory root fields, filters, and workspace boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-memory-root-parity-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const { client, child } = await startWorker(directory)
  cleanup.push(async () => {
    client.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
  const dbPath = join(directory, 'data.db')
  expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
  const projectFolder = join(directory, 'team-project')
  const roots: MemoryRootDescriptor[] = []
  for (const input of [
    { scope: 'global', rootPath: join(directory, 'personal'), workspaceId: 'local-personal' },
    { scope: 'global', rootPath: join(directory, 'team'), workspaceId: 'team-a' },
    {
      scope: 'project',
      rootPath: projectFolder,
      workingFolder: projectFolder,
      workspaceId: 'team-a'
    }
  ]) {
    const root = (await client.request('db/memory-roots-ensure', {
      dbPath,
      ...input
    })) as MemoryRootDescriptor
    expect(root.id).toBeTypeOf('string')
    roots.push(root)
  }
  for (const workspaceId of ['local-personal', 'team-a']) {
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id: `session-${workspaceId}`,
          title: workspaceId,
          mode: 'chat',
          workspaceId
        })
      ).success
    ).toBe(true)
  }
  const jobs: MemoryPipelineJob[] = []
  for (const input of [
    { workspaceId: 'local-personal', memoryRootId: roots[0].id, status: 'succeeded' },
    { workspaceId: 'team-a', memoryRootId: roots[1].id, status: 'running' },
    { workspaceId: 'team-a', memoryRootId: roots[2].id, status: 'succeeded' }
  ]) {
    const job = (await client.request('db/memory-jobs-create', {
      dbPath,
      kind: 'phase2',
      sourceSessionId: `session-${input.workspaceId}`,
      ...input
    })) as MemoryPipelineJob
    expect(job.id).toBeTypeOf('string')
    jobs.push(job)
  }
  for (const status of ['active', 'filtered']) {
    const output = (await client.request('db/memory-stage1-add', {
      dbPath,
      workspaceId: 'team-a',
      memoryRootId: roots[2].id,
      scope: 'project',
      sourceSessionId: 'session-team-a',
      rawMemory: status,
      rolloutSummary: status,
      rolloutSlug: status,
      fingerprint: status,
      status
    })) as MemoryStage1Output
    expect(output.id).toBeTypeOf('string')
  }
  const reader = new LegacyReadRepository(dbPath)
  cleanup.push(() => reader.close())
  const queries: Array<MemoryPipelineListRootsQuery & { workspaceId: string }> = [
    { workspaceId: 'local-personal' },
    { workspaceId: 'team-a' },
    { workspaceId: 'team-b' },
    { workspaceId: 'team-a', scope: 'project' },
    { workspaceId: 'team-a', scope: 'both', projectId: null },
    { workspaceId: 'team-a', workingFolder: projectFolder },
    { workspaceId: 'team-a', rootPath: projectFolder }
  ]
  for (const query of queries) {
    expect(await reader.memoryRoots(query)).toEqual(
      await client.request('db/memory-roots-list', { dbPath, ...query })
    )
  }
  const teamRoot = roots[1]
  expect(await reader.memoryRoot(teamRoot.id, 'team-a')).toEqual(
    (
      await client.request('db/memory-roots-get', {
        dbPath,
        id: teamRoot.id,
        workspaceId: 'team-a'
      })
    ).root
  )
  expect(await reader.memoryRoot(teamRoot.id, 'local-personal')).toBeNull()
  const jobQueries: Array<MemoryPipelineListJobsQuery & { workspaceId: string }> = [
    { workspaceId: 'local-personal' },
    { workspaceId: 'team-a' },
    { workspaceId: 'team-b' },
    { workspaceId: 'team-a', statuses: ['running'] },
    { workspaceId: 'team-a', kinds: ['phase2'], limit: 1 },
    { workspaceId: 'team-a', memoryRootId: roots[2].id },
    { workspaceId: 'team-a', sourceSessionId: 'session-team-a' }
  ]
  for (const query of jobQueries) {
    expect(await reader.memoryJobs(query)).toEqual(
      await client.request('db/memory-jobs-list', { dbPath, ...query })
    )
  }
  expect(await reader.memoryJob(jobs[1].id, 'team-a')).toEqual(
    (
      await client.request('db/memory-jobs-get', {
        dbPath,
        id: jobs[1].id,
        workspaceId: 'team-a'
      })
    ).job
  )
  expect(await reader.memoryJob(jobs[1].id, 'local-personal')).toBeNull()
  expect(
    await reader.memoryStage1Outputs({
      memoryRootId: roots[2].id,
      workspaceId: 'team-a',
      limit: 1
    })
  ).toEqual(
    await client.request('db/memory-stage1-list', {
      dbPath,
      memoryRootId: roots[2].id,
      workspaceId: 'team-a',
      limit: 1
    })
  )
  await expect(
    reader.memoryStage1Outputs({ memoryRootId: roots[2].id, workspaceId: 'local-personal' })
  ).rejects.toThrow('LEGACY_MEMORY_ROOT_NOT_FOUND')

  process.env.OLA_TS_LEGACY_READ_PATH = dbPath
  delete process.env.OLA_TS_MEMORY_ROOT_READS
  expect(await canaryListMemoryRoots({ workspaceId: 'team-a' })).toEqual(
    await client.request('db/memory-roots-list', { dbPath, workspaceId: 'team-a' })
  )
  expect(await canaryGetMemoryRoot(teamRoot.id, 'team-a')).toEqual(teamRoot)
  expect(await canaryListMemoryJobs({ workspaceId: 'team-a' })).toEqual(
    await client.request('db/memory-jobs-list', { dbPath, workspaceId: 'team-a' })
  )
  expect(await canaryGetMemoryJob(jobs[1].id, 'team-a')).toEqual(jobs[1])
  expect(
    await canaryListMemoryStage1Outputs({ memoryRootId: roots[2].id, workspaceId: 'team-a' })
  ).toEqual(
    await client.request('db/memory-stage1-list', {
      dbPath,
      memoryRootId: roots[2].id,
      workspaceId: 'team-a'
    })
  )
  process.env.OLA_TS_MEMORY_ROOT_READS = '0'
  expect(await canaryListMemoryRoots({ workspaceId: 'team-a' })).toBeUndefined()
  expect(await canaryGetMemoryRoot(teamRoot.id, 'team-a')).toBeUndefined()
  expect(await canaryListMemoryJobs({ workspaceId: 'team-a' })).toBeUndefined()
  expect(await canaryGetMemoryJob(jobs[1].id, 'team-a')).toBeUndefined()
  expect(
    await canaryListMemoryStage1Outputs({ memoryRootId: roots[2].id, workspaceId: 'team-a' })
  ).toBeUndefined()
}, 30_000)
