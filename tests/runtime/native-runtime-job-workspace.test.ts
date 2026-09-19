import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('Native runtime job workspace boundary', () => {
  it('derives job ownership from sessions and scopes idempotency, state, lists and replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-runtime-job-workspace-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const { client, child } = await startWorker(directory)
    cleanup.push(async () => {
      client.close()
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
    })
    const dbPath = join(directory, 'native.db')
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    for (const [id, workspaceId] of [
      ['personal-session', 'local-personal'],
      ['team-session', 'team-a']
    ]) {
      expect(
        (
          await client.request('db/sessions-create', {
            dbPath,
            id,
            title: id,
            mode: 'chat',
            workspaceId
          })
        ).success
      ).toBe(true)
    }
    const submit = (jobId: string, sessionId: string, workspaceId: string) =>
      client.request('runtime/jobs-submit', {
        dbPath,
        jobId,
        sessionId,
        workspaceId,
        method: 'agent/run',
        idempotencyKey: 'same-key',
        params: {}
      })
    expect(await submit('spoof', 'team-session', 'local-personal')).toMatchObject({
      error: expect.stringContaining('another workspace')
    })
    expect((await submit('team-job', 'team-session', 'team-a')).accepted).toBe(true)
    expect((await submit('personal-job', 'personal-session', 'local-personal')).accepted).toBe(true)
    expect((await submit('team-duplicate', 'team-session', 'team-a')).duplicate).toBe(true)
    expect(
      (await client.request('runtime/jobs-list', { dbPath, workspaceId: 'team-a' })).map(
        (job: { jobId: string }) => job.jobId
      )
    ).toEqual(['team-job'])
    expect(
      (
        await client.request('runtime/jobs-get', {
          dbPath,
          jobId: 'team-job',
          workspaceId: 'local-personal'
        })
      ).found
    ).toBe(false)
    expect(
      await client.request('runtime/jobs-state', {
        dbPath,
        jobId: 'team-job',
        workspaceId: 'local-personal',
        state: 'failed'
      })
    ).toBeNull()
    expect(
      await client.request('runtime/jobs-cancel', {
        dbPath,
        jobId: 'team-job',
        workspaceId: 'local-personal'
      })
    ).toBeNull()
    const database = new DatabaseSync(dbPath)
    try {
      database
        .prepare(
          `INSERT INTO runtime_job_events
        (job_id,seq,payload_json,terminal,created_at) VALUES (?,?,?,?,?)`
        )
        .run('team-job', 1, '{"private":"team"}', 0, 1000)
    } finally {
      database.close()
    }
    expect(
      await client.request('runtime/jobs-events', {
        dbPath,
        jobId: 'team-job',
        workspaceId: 'local-personal'
      })
    ).toEqual([])
    expect(
      await client.request('runtime/jobs-events', {
        dbPath,
        jobId: 'team-job',
        workspaceId: 'team-a'
      })
    ).toEqual([expect.objectContaining({ payloadJson: '{"private":"team"}' })])
    expect(
      (
        await client.request('runtime/jobs-get', {
          dbPath,
          jobId: 'team-job',
          workspaceId: 'team-a'
        })
      ).job
    ).toMatchObject({ state: 'queued', workspaceId: 'team-a' })
  }, 30_000)

  it('backfills old session-owned jobs before creating scoped indexes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-runtime-job-migration-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const { client, child } = await startWorker(directory)
    cleanup.push(async () => {
      client.close()
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
    })
    const dbPath = join(directory, 'native.db')
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    await client.request('db/sessions-create', {
      dbPath,
      id: 'team-session',
      title: 'Team',
      mode: 'chat',
      workspaceId: 'team-a'
    })
    expect(
      (
        await client.request('runtime/jobs-submit', {
          dbPath,
          jobId: 'legacy-team',
          sessionId: 'team-session',
          workspaceId: 'team-a',
          method: 'agent/run',
          idempotencyKey: 'legacy-key'
        })
      ).accepted
    ).toBe(true)
    const database = new DatabaseSync(dbPath)
    try {
      database.exec(`
        DROP INDEX idx_runtime_jobs_workspace_idempotency;
        DROP INDEX idx_runtime_jobs_workspace_created;
        ALTER TABLE runtime_jobs DROP COLUMN workspace_id;
        CREATE UNIQUE INDEX idx_runtime_jobs_idempotency ON runtime_jobs(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
      `)
    } finally {
      database.close()
    }
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    expect(
      (
        await client.request('runtime/jobs-get', {
          dbPath,
          jobId: 'legacy-team',
          workspaceId: 'team-a'
        })
      ).job
    ).toMatchObject({ workspaceId: 'team-a' })
  }, 30_000)
})
