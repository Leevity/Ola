import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../../src/main/lib/native-worker', () => ({
  getNativeWorker: () => ({ request: state.request })
}))

import {
  getCronJob,
  getCronRun,
  getCronRunDetail,
  listCronJobs,
  listCronRuns
} from '../../src/main/db/cron-dao'
import { closeLegacyReadCanary } from '../../src/main/db/legacy-read-canary'

const originalPath = process.env.OLA_TS_LEGACY_READ_PATH
const originalEnabled = process.env.OLA_TS_CRON_JOB_READS
const originalRunEnabled = process.env.OLA_TS_CRON_RUN_READS
const cleanup: string[] = []

afterEach(async () => {
  await closeLegacyReadCanary()
  state.request.mockReset()
  if (originalPath === undefined) delete process.env.OLA_TS_LEGACY_READ_PATH
  else process.env.OLA_TS_LEGACY_READ_PATH = originalPath
  if (originalEnabled === undefined) delete process.env.OLA_TS_CRON_JOB_READS
  else process.env.OLA_TS_CRON_JOB_READS = originalEnabled
  if (originalRunEnabled === undefined) delete process.env.OLA_TS_CRON_RUN_READS
  else process.env.OLA_TS_CRON_RUN_READS = originalRunEnabled
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true })
})

it('serves scoped Cron reads from TS without calling the Native writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-cron-read-canary-'))
  cleanup.push(directory)
  const path = join(directory, 'data.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule_kind TEXT, schedule_at INTEGER,
        schedule_every INTEGER, schedule_expr TEXT, schedule_tz TEXT, prompt TEXT,
        agent_id TEXT, model TEXT, model_source TEXT, working_folder TEXT,
        ssh_connection_id TEXT, session_id TEXT, source_session_title TEXT,
        source_project_id TEXT, source_project_name TEXT, source_provider_id TEXT,
        delivery_mode TEXT, delivery_target TEXT, plugin_id TEXT, plugin_chat_id TEXT,
        enabled INTEGER, delete_after_run INTEGER, max_iterations INTEGER,
        deleted_at INTEGER, last_fired_at INTEGER, fire_count INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER, workspace_id TEXT NOT NULL
      );
      INSERT INTO cron_jobs (id, name, created_at, workspace_id)
        VALUES ('team-job', 'Team', 2, 'team-a');
      INSERT INTO cron_jobs (id, name, created_at, workspace_id)
        VALUES ('other-job', 'Other', 1, 'team-b');
      CREATE TABLE cron_runs (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, started_at INTEGER NOT NULL,
        finished_at INTEGER, status TEXT NOT NULL, tool_call_count INTEGER NOT NULL,
        output_summary TEXT, error TEXT, scheduled_for INTEGER, job_name_snapshot TEXT,
        prompt_snapshot TEXT, source_session_id_snapshot TEXT, source_session_title_snapshot TEXT,
        source_project_id_snapshot TEXT, source_project_name_snapshot TEXT,
        source_provider_id_snapshot TEXT, model_snapshot TEXT, model_source_snapshot TEXT,
        working_folder_snapshot TEXT, delivery_mode_snapshot TEXT, delivery_target_snapshot TEXT
      );
      INSERT INTO cron_runs (id, job_id, started_at, status, tool_call_count)
        VALUES ('team-run', 'team-job', 10, 'running', 0),
               ('other-run', 'other-job', 11, 'running', 0);
      CREATE TABLE cron_run_messages (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        usage TEXT, message_source TEXT, sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT INTO cron_run_messages (id, run_id, role, content, sort_order, created_at)
        VALUES ('message-1', 'team-run', 'user', '"hello"', 0, 12);
      CREATE TABLE cron_run_logs (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
        type TEXT NOT NULL, content TEXT NOT NULL, sort_order INTEGER NOT NULL
      );
      INSERT INTO cron_run_logs (id, run_id, timestamp, type, content, sort_order)
        VALUES ('log-1', 'team-run', 13, 'text', 'working', 0);
    `)
  } finally {
    db.close()
  }
  process.env.OLA_TS_LEGACY_READ_PATH = path
  delete process.env.OLA_TS_CRON_JOB_READS
  expect((await listCronJobs({ workspaceId: 'team-a' })).map((job) => job.id)).toEqual(['team-job'])
  expect((await getCronJob('team-job', 'team-a'))?.id).toBe('team-job')
  expect(await getCronJob('team-job', 'team-b')).toBeNull()
  expect((await listCronRuns({ workspaceId: 'team-a' })).map((run) => run.id)).toEqual(['team-run'])
  expect((await getCronRun('team-run', 'team-a'))?.id).toBe('team-run')
  expect(await getCronRun('team-run', 'team-b')).toBeNull()
  const detail = await getCronRunDetail('team-run', 'team-a')
  expect(detail.messages.map((message) => message.id)).toEqual(['message-1'])
  expect(detail.logs.map((log) => log.id)).toEqual(['log-1'])
  expect(state.request).not.toHaveBeenCalled()
})

it('keeps unscoped and opt-out Cron reads on Native', async () => {
  process.env.OLA_TS_CRON_JOB_READS = '0'
  state.request.mockResolvedValueOnce({ success: true, jobs: [] })
  await expect(listCronJobs({ workspaceId: 'team-a' })).resolves.toEqual([])
  expect(state.request).toHaveBeenCalledWith(
    'db/cron-jobs-list',
    { workspaceId: 'team-a' },
    120_000
  )
  delete process.env.OLA_TS_CRON_JOB_READS
  state.request.mockResolvedValueOnce({ success: true, job: null })
  await expect(getCronJob('missing')).resolves.toBeNull()
  expect(state.request).toHaveBeenCalledWith(
    'db/cron-jobs-get',
    { jobId: 'missing', workspaceId: undefined },
    120_000
  )
  process.env.OLA_TS_CRON_RUN_READS = '0'
  state.request.mockResolvedValueOnce({ success: true, runs: [] })
  await expect(listCronRuns({ workspaceId: 'team-a' })).resolves.toEqual([])
  expect(state.request).toHaveBeenCalledWith(
    'db/cron-runs-list',
    { workspaceId: 'team-a' },
    120_000
  )
  delete process.env.OLA_TS_CRON_RUN_READS
  state.request.mockResolvedValueOnce({ success: true, run: null })
  await expect(getCronRun('missing')).resolves.toBeNull()
  expect(state.request).toHaveBeenCalledWith(
    'db/cron-runs-get',
    { runId: 'missing', workspaceId: undefined },
    120_000
  )
})

it('falls back to Native when the TS Cron run reader cannot understand the schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-cron-read-fallback-'))
  cleanup.push(directory)
  const path = join(directory, 'data.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)')
  db.close()
  process.env.OLA_TS_LEGACY_READ_PATH = path
  delete process.env.OLA_TS_CRON_RUN_READS
  state.request.mockResolvedValueOnce({ success: true, runs: [] })
  await expect(listCronRuns({ workspaceId: 'team-a' })).resolves.toEqual([])
  expect(state.request).toHaveBeenCalledWith(
    'db/cron-runs-list',
    { workspaceId: 'team-a' },
    120_000
  )
})
