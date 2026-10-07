import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateBusinessSchema } from '../../src/runtime/storage/business-schema.mjs'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createLegacyDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), 'ola-schema-legacy-'))
  directories.push(directory)
  const db = new DatabaseSync(join(directory, 'data.db'))
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL, project_id TEXT, working_folder TEXT,
      ssh_connection_id TEXT, plan_id TEXT, pinned INTEGER, plugin_id TEXT,
      external_chat_id TEXT, provider_id TEXT, model_id TEXT,
      model_selection_mode TEXT
    );
    INSERT INTO sessions(id, title, mode, created_at, updated_at, message_count)
      VALUES('s1', 'legacy session', 'chat', 1, 1, 0);
  `)
  return db
}

describe('business schema legacy additive migration', () => {
  it('backfills required columns missing from a legacy Native table', () => {
    const db = createLegacyDatabase()
    try {
      migrateBusinessSchema(db, { direct: true })
      const columns = new Set(
        db
          .prepare('PRAGMA table_info(sessions)')
          .all()
          .map((row) => row.name)
      )
      expect(columns.has('workspace_id')).toBe(true)
      expect(columns.has('model_source')).toBe(true)
      expect(columns.has('task_profile')).toBe(true)
      expect(columns.has('task_profile_locked')).toBe(true)
      expect(columns.has('scenario_policy')).toBe(true)
      expect(
        db
          .prepare('PRAGMA table_info(sessions)')
          .all()
          .find((column) => column.name === 'task_profile_locked')
      ).toMatchObject({ dflt_value: '0' })
    } finally {
      db.close()
    }
  })

  it('claims existing legacy rows as local-personal after the additive migration', () => {
    const db = createLegacyDatabase()
    try {
      migrateBusinessSchema(db, { direct: true })
      const row = db.prepare("SELECT workspace_id FROM sessions WHERE id='s1'").get()
      expect(row).toEqual({ workspace_id: 'local-personal' })
    } finally {
      db.close()
    }
  })

  it('leaves a current schema untouched and still records its migration', () => {
    const db = createLegacyDatabase()
    try {
      migrateBusinessSchema(db, { direct: true })
      migrateBusinessSchema(db, { direct: true })
      const columns = new Set(
        db
          .prepare('PRAGMA table_info(sessions)')
          .all()
          .map((row) => row.name)
      )
      expect(columns.has('workspace_id')).toBe(true)
      const applied = db
        .prepare('SELECT version FROM ola_ts_schema_migrations ORDER BY version')
        .all()
      expect(applied.length).toBeGreaterThanOrEqual(3)
    } finally {
      db.close()
    }
  })

  it('creates an isolated Cron delivery ledger on the additive migration', () => {
    const db = createLegacyDatabase()
    try {
      migrateBusinessSchema(db, { direct: true })
      const columns = db.prepare('PRAGMA table_info(cron_run_deliveries)').all()
      expect(columns.map((column) => column.name)).toEqual([
        'id',
        'run_id',
        'tool_call_id',
        'kind',
        'status',
        'started_at',
        'finished_at',
        'error_code',
        'retry_of_id',
        'attempt_number',
        'plugin_id',
        'chat_id'
      ])
      expect(
        db.prepare('SELECT version,description FROM ola_ts_schema_migrations WHERE version=6').get()
      ).toEqual({
        version: 6,
        description: 'persisted Cron delivery attempts independent of execution'
      })
      expect(
        db.prepare('SELECT version,description FROM ola_ts_schema_migrations WHERE version=7').get()
      ).toEqual({ version: 7, description: 'idempotent Cron delivery-only retries' })
      expect(
        db.prepare('SELECT version,description FROM ola_ts_schema_migrations WHERE version=8').get()
      ).toEqual({ version: 8, description: 'distinguish scheduled, manual, and trial Cron runs' })
      expect(
        db
          .prepare('PRAGMA table_info(cron_runs)')
          .all()
          .some((column) => column.name === 'run_kind')
      ).toBe(true)
      expect(
        db
          .prepare('SELECT version,description FROM ola_ts_schema_migrations WHERE version=10')
          .get()
      ).toEqual({
        version: 10,
        description: 'persist task profile selection and lock state on sessions'
      })
      expect(
        db
          .prepare('PRAGMA table_info(cron_runs)')
          .all()
          .find((column) => column.name === 'run_kind')
      ).toMatchObject({ dflt_value: "'scheduled'" })
    } finally {
      db.close()
    }
  })

  it('adds workspace ownership to legacy desktop automation flows and backfills existing rows', () => {
    const db = createLegacyDatabase()
    try {
      db.exec(`
        CREATE TABLE desktop_flows (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, flow_json TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        INSERT INTO desktop_flows VALUES('flow-1', 'Legacy flow', '{}', 1, 2);
      `)
      migrateBusinessSchema(db, { direct: true })
      expect(db.prepare('SELECT workspace_id FROM desktop_flows WHERE id=?').get('flow-1')).toEqual(
        {
          workspace_id: 'local-personal'
        }
      )
      expect(
        db
          .prepare('PRAGMA table_info(desktop_flows)')
          .all()
          .some((column) => column.name === 'workspace_id')
      ).toBe(true)
      expect(
        db.prepare('SELECT version,description FROM ola_ts_schema_migrations WHERE version=9').get()
      ).toEqual({
        version: 9,
        description: 'workspace ownership for desktop automation flows'
      })
    } finally {
      db.close()
    }
  })
})
