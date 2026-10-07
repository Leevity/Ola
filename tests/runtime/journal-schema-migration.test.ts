import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunJournal } from '../../src/runtime/storage/run-journal'

const schemaModule = await import('../../src/runtime/storage/journal-schema.mjs')

const directories: string[] = []
const journals: RunJournal[] = []

afterEach(async () => {
  await Promise.all(journals.splice(0).map((journal) => journal.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function pathFor(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `ola-${name}-`))
  directories.push(directory)
  return join(directory, 'runs.db')
}

function version(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return Number(database.prepare('PRAGMA user_version').get()?.user_version ?? -1)
  } finally {
    database.close()
  }
}

describe('runtime journal schema migrations', () => {
  it('pages run summaries in stable journal order', async () => {
    const path = await pathFor('journal-run-pages')
    const journal = new RunJournal(path)
    journals.push(journal)
    for (const index of [1, 2, 3]) {
      await journal.create({
        runId: `run-${index}`,
        taskId: `task-${index}`,
        requestId: `request-${index}`,
        traceId: `trace-${index}`,
        sessionId: 'session',
        workspaceId: 'local-personal',
        environmentId: 'local',
        modelSource: { kind: 'local', providerId: 'local', modelId: 'model' },
        prompt: 'test',
        unattended: false
      })
    }
    const first = await journal.list('local-personal', 2, 0)
    const second = await journal.list('local-personal', 2, 2)
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(1)
    expect(new Set([...first, ...second].map((run) => run.runId))).toEqual(
      new Set(['run-1', 'run-2', 'run-3'])
    )
    expect(await journal.list('other-workspace', 2, 0)).toEqual([])
    const anchor = { at: first[0].createdAt, id: first[0].runId }
    const after = { at: first[1].createdAt, id: first[1].runId }
    await journal.create({
      runId: 'run-4',
      taskId: 'task-4',
      requestId: 'request-4',
      traceId: 'trace-4',
      sessionId: 'session',
      workspaceId: 'local-personal',
      environmentId: 'local',
      modelSource: { kind: 'local', providerId: 'local', modelId: 'model' },
      prompt: 'later',
      unattended: false
    })
    expect(
      (await journal.list('local-personal', 2, 0, false, anchor, after)).map((run) => run.runId)
    ).toEqual(second.map((run) => run.runId))
    await journal.transition('run-2', 'local-personal', ['queued'], 'failed')
    expect((await journal.list('local-personal', 2, 0, true)).map((run) => run.runId)).toEqual([
      'run-2'
    ])
  })

  it('upgrades a v1 journal transactionally without replacing existing run data', async () => {
    const path = await pathFor('journal-v1')
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL, status TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
        spec TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE events (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
        data TEXT NOT NULL, timestamp INTEGER NOT NULL, PRIMARY KEY(run_id, seq)
      );
      INSERT INTO runs VALUES ('legacy-run', 'legacy-request', 'local-personal', 'session',
        'completed', 1, '{"runId":"legacy-run","requestId":"legacy-request",' ||
        '"workspaceId":"local-personal","sessionId":"session","traceId":"trace",' ||
        '"taskId":"task","environmentId":"local","prompt":"done",' ||
        '"modelSource":{"kind":"local","providerId":"p","modelId":"m"}}', 1, 1);
      INSERT INTO events VALUES ('legacy-run', 1, 'run.status', '{"status":"completed"}', 1);
      PRAGMA user_version=1;
    `)
    database.close()

    const journal = new RunJournal(path)
    journals.push(journal)
    expect((await journal.snapshot('legacy-run', 'local-personal'))?.run.status).toBe('completed')
    expect(version(path)).toBe(6)

    const check = new DatabaseSync(path, { readOnly: true })
    try {
      expect(
        check
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='interactions'")
          .get()
      ).toBeTruthy()
      expect(
        check
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='runs_session_workspace'"
          )
          .get()
      ).toBeTruthy()
      expect(
        check
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='events_artifacts_recent'"
          )
          .get()
      ).toBeTruthy()
      expect(
        check
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hidden_artifacts'")
          .get()
      ).toBeTruthy()
      expect(
        check
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='runs_workspace_created_id'"
          )
          .get()
      ).toBeTruthy()
    } finally {
      check.close()
    }
  })

  it('does not advance the version when an interrupted upgrade cannot create its table', async () => {
    const path = await pathFor('journal-invalid-v1')
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, request_id TEXT, workspace_id TEXT, session_id TEXT,
        status TEXT, seq INTEGER, spec TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE events (run_id TEXT, seq INTEGER, type TEXT, data TEXT, timestamp INTEGER);
      CREATE VIEW interactions AS SELECT 1 AS incompatible;
      PRAGMA user_version=1;
    `)
    database.close()

    const invalid = new DatabaseSync(path)
    try {
      expect(() => schemaModule.migrateJournalSchema(invalid)).toThrow('views may not be indexed')
    } finally {
      invalid.close()
    }
    expect(version(path)).toBe(1)
  })
})
