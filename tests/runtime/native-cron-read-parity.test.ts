import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import type {
  CronJobRecord,
  CronRunLogRow,
  CronRunMessageRow,
  CronRunRecord
} from '../../src/main/db/cron-dao'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('matches Native Cron definition reads and workspace filters on a real database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-cron-read-parity-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const { client, child } = await startWorker(directory)
  cleanup.push(async () => {
    client.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
  const dbPath = join(directory, 'native.db')
  expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
  for (const job of [
    { id: 'team-visible', workspace_id: 'team-a', session_id: null },
    { id: 'team-deleted', workspace_id: 'team-a', session_id: null },
    { id: 'other-team', workspace_id: 'team-b', session_id: null }
  ]) {
    expect(
      (
        await client.request('db/cron-jobs-create', {
          dbPath,
          job: {
            ...job,
            name: job.id,
            schedule_kind: 'every',
            schedule_every: 60_000,
            prompt: 'Keep working'
          }
        })
      ).success
    ).toBe(true)
  }
  expect(
    (
      await client.request('db/cron-jobs-soft-delete', {
        dbPath,
        jobId: 'team-deleted',
        workspaceId: 'team-a',
        deletedAt: 100,
        updatedAt: 100
      })
    ).success
  ).toBe(true)

  const reader = new LegacyReadRepository(dbPath)
  cleanup.push(() => reader.close())
  const nativeVisible = await client.request('db/cron-jobs-list', {
    dbPath,
    workspaceId: 'team-a'
  })
  expect(await reader.cronJobs<CronJobRecord>({ workspaceId: 'team-a' })).toEqual(
    nativeVisible.jobs
  )
  const nativeAll = await client.request('db/cron-jobs-list', {
    dbPath,
    workspaceId: 'team-a',
    includeDeleted: true
  })
  expect(
    await reader.cronJobs<CronJobRecord>({ workspaceId: 'team-a', includeDeleted: true })
  ).toEqual(nativeAll.jobs)
  expect(
    (await reader.cronJobs<CronJobRecord>({ workspaceId: 'team-b' })).map((job) => job.id)
  ).toEqual(['other-team'])
  const nativeJob = await client.request('db/cron-jobs-get', {
    dbPath,
    jobId: 'team-visible',
    workspaceId: 'team-a'
  })
  expect(await reader.cronJob('team-visible', 'team-a')).toEqual(nativeJob.job)
  expect(await reader.cronJob('team-visible', 'team-b')).toBeNull()
  expect(
    (
      await client.request('db/cron-runs-create', {
        dbPath,
        runId: 'team-run',
        jobId: 'team-visible',
        startedAt: 200,
        sourceSessionIdSnapshot: 'session-a'
      })
    ).success
  ).toBe(true)
  expect(
    (
      await client.request('db/cron-runs-get', {
        dbPath,
        runId: 'team-run',
        workspaceId: 'team-a'
      })
    ).run?.id
  ).toBe('team-run')
  expect(
    (
      await client.request('db/cron-runs-get', {
        dbPath,
        runId: 'team-run',
        workspaceId: 'team-b'
      })
    ).run ?? null
  ).toBeNull()
  for (const [method, args] of [
    ['db/cron-runs-create', { runId: 'cross-run', jobId: 'team-visible', startedAt: 300 }],
    ['db/cron-runs-update', { runId: 'team-run', patch: { status: 'success' } }],
    ['db/cron-run-messages-replace', { runId: 'team-run', messages: [] }],
    [
      'db/cron-run-log-append',
      { id: 'cross-log', runId: 'team-run', type: 'text', content: 'not allowed' }
    ]
  ] as const) {
    expect((await client.request(method, { dbPath, workspaceId: 'team-b', ...args })).success).toBe(
      false
    )
  }
  expect(
    (
      await client.request('db/cron-runs-get', {
        dbPath,
        runId: 'team-run',
        workspaceId: 'team-a'
      })
    ).run?.status
  ).toBe('running')
  for (const [runId, jobId, startedAt] of [
    ['team-earlier', 'team-visible', 100],
    ['other-run', 'other-team', 300]
  ] as const) {
    expect(
      (await client.request('db/cron-runs-create', { dbPath, runId, jobId, startedAt })).success
    ).toBe(true)
  }
  expect(
    (
      await client.request('db/cron-run-messages-replace', {
        dbPath,
        runId: 'team-run',
        workspaceId: 'team-a',
        messages: [
          { id: 'message-1', role: 'user', content: { text: 'hello' }, createdAt: 210 },
          { id: 'message-2', role: 'assistant', content: { text: 'done' }, createdAt: 220 }
        ]
      })
    ).success
  ).toBe(true)
  expect(
    (
      await client.request('db/cron-run-log-append', {
        dbPath,
        id: 'log-1',
        runId: 'team-run',
        workspaceId: 'team-a',
        timestamp: 230,
        type: 'text',
        content: 'progress'
      })
    ).success
  ).toBe(true)

  for (const query of [
    { workspaceId: 'team-a' },
    { workspaceId: 'team-b' },
    { workspaceId: 'team-a', jobId: 'team-visible', start: 150, end: 250, limit: 1 },
    { workspaceId: 'team-a', sessionId: 'session-a' },
    { workspaceId: 'team-a', sessionId: 'missing' }
  ]) {
    const native = await client.request('db/cron-runs-list', { dbPath, ...query })
    expect(await reader.cronRuns<CronRunRecord>(query)).toEqual(native.runs)
  }
  const nativeRun = await client.request('db/cron-runs-get', {
    dbPath,
    runId: 'team-run',
    workspaceId: 'team-a'
  })
  expect(await reader.cronRun<CronRunRecord>('team-run', 'team-a')).toEqual(nativeRun.run)
  expect(await reader.cronRun('team-run', 'team-b')).toBeNull()
  const nativeDetail = await client.request('db/cron-run-detail', {
    dbPath,
    runId: 'team-run',
    workspaceId: 'team-a'
  })
  expect(
    await reader.cronRunDetail<CronRunRecord, CronJobRecord, CronRunMessageRow, CronRunLogRow>(
      'team-run',
      'team-a'
    )
  ).toEqual({
    run: nativeDetail.run,
    job: nativeDetail.job,
    messages: nativeDetail.messages,
    logs: nativeDetail.logs
  })
  expect(await reader.cronRunDetail('team-run', 'team-b')).toBeNull()
}, 30_000)

it('rejects Cron definitions linked to sessions or projects in another workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-cron-scope-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const { client, child } = await startWorker(directory)
  cleanup.push(async () => {
    client.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
  const dbPath = join(directory, 'native.db')
  expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
  for (const workspaceId of ['team-a', 'team-b']) {
    expect(
      (
        await client.request('db/projects-create', {
          dbPath,
          id: `project-${workspaceId}`,
          name: workspaceId,
          workspaceId,
          workingFolder: join(directory, `project-${workspaceId}`)
        })
      ).id
    ).toBe(`project-${workspaceId}`)
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
  const job = {
    id: 'scoped-job',
    workspace_id: 'team-a',
    session_id: 'session-team-a',
    source_project_id: 'project-team-a',
    name: 'Scoped',
    schedule_kind: 'every',
    schedule_every: 60_000,
    prompt: 'Keep working'
  }
  expect(
    (
      await client.request('db/cron-jobs-create', {
        dbPath,
        workspaceId: 'team-b',
        job
      })
    ).success
  ).toBe(false)
  expect(
    (
      await client.request('db/cron-jobs-create', {
        dbPath,
        job: { ...job, id: 'bad-session', session_id: 'session-team-b' }
      })
    ).success
  ).toBe(false)
  expect(
    (
      await client.request('db/cron-jobs-create', {
        dbPath,
        job: { ...job, id: 'bad-project', source_project_id: 'project-team-b' }
      })
    ).success
  ).toBe(false)
  expect(
    (
      await client.request('db/cron-jobs-create', {
        dbPath,
        job: {
          ...job,
          id: 'bad-model',
          model_source: JSON.stringify({
            kind: 'ola-team',
            workspaceId: 'team-b',
            resourceId: 'model-b'
          })
        }
      })
    ).success
  ).toBe(false)
  expect(
    (
      await client.request('db/cron-jobs-create', {
        dbPath,
        job: { ...job, id: 'bad-provider', source_provider_id: 'ola-managed:team-b' }
      })
    ).success
  ).toBe(false)
  expect((await client.request('db/cron-jobs-create', { dbPath, job })).success).toBe(true)
  for (const snapshot of [
    { sourceSessionIdSnapshot: 'session-team-b' },
    { sourceProjectIdSnapshot: 'project-team-b' },
    {
      modelSourceSnapshot: JSON.stringify({
        kind: 'ola-team',
        workspaceId: 'team-b',
        resourceId: 'model-b'
      })
    },
    { sourceProviderIdSnapshot: 'ola-managed:team-b' }
  ]) {
    expect(
      (
        await client.request('db/cron-runs-create', {
          dbPath,
          workspaceId: 'team-a',
          runId: `cross-source-${Object.keys(snapshot)[0]}`,
          jobId: job.id,
          startedAt: 1,
          ...snapshot
        })
      ).success
    ).toBe(false)
  }
  expect(
    (
      await client.request('db/cron-runs-create', {
        dbPath,
        workspaceId: 'team-a',
        runId: 'same-source',
        jobId: job.id,
        startedAt: 1,
        sourceSessionIdSnapshot: 'session-team-a',
        sourceProjectIdSnapshot: 'project-team-a',
        modelSourceSnapshot: JSON.stringify({
          kind: 'ola-team',
          workspaceId: 'team-a',
          resourceId: 'model-a'
        }),
        sourceProviderIdSnapshot: 'ola-managed:team-a'
      })
    ).success
  ).toBe(true)
  const original = (
    await client.request('db/cron-jobs-get', {
      dbPath,
      jobId: 'scoped-job',
      workspaceId: 'team-a'
    })
  ).job
  expect(original?.session_id).toBe('session-team-a')
  expect(original?.source_project_id).toBe('project-team-a')
  for (const patch of [
    { session_id: 'session-team-b' },
    { source_project_id: 'project-team-b' },
    { source_provider_id: 'ola-managed:team-b' },
    { workspace_id: 'team-b' }
  ]) {
    expect(
      (
        await client.request('db/cron-jobs-update', {
          dbPath,
          workspaceId: 'team-a',
          job: { ...original, ...patch }
        })
      ).success
    ).toBe(false)
  }
  expect(
    (
      await client.request('db/cron-jobs-get', {
        dbPath,
        jobId: 'scoped-job',
        workspaceId: 'team-a'
      })
    ).job
  ).toEqual(original)
  expect(
    (
      await client.request('db/cron-jobs-get', {
        dbPath,
        jobId: 'scoped-job',
        workspaceId: 'team-b'
      })
    ).job ?? null
  ).toBeNull()
  expect(
    (
      await client.request('db/cron-jobs-update', {
        dbPath,
        workspaceId: 'team-a',
        job: { ...original, name: 'Scoped updated' }
      })
    ).success
  ).toBe(true)
  expect(
    (
      await client.request('db/cron-jobs-get', {
        dbPath,
        jobId: 'scoped-job',
        workspaceId: 'team-a'
      })
    ).job?.name
  ).toBe('Scoped updated')
}, 30_000)
