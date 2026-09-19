export const LATEST_JOURNAL_SCHEMA_VERSION = 3

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS runs (
       id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
       session_id TEXT NOT NULL, status TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
       spec TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_workspace_status ON runs(workspace_id, status);
      CREATE TABLE IF NOT EXISTS events (
       run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, type TEXT NOT NULL,
       data TEXT NOT NULL, timestamp INTEGER NOT NULL, PRIMARY KEY(run_id, seq)
      );
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS interactions (
       run_id TEXT NOT NULL REFERENCES runs(id), interaction_id TEXT NOT NULL,
       kind TEXT NOT NULL, payload TEXT NOT NULL, version TEXT,
       status TEXT NOT NULL, response TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER,
       PRIMARY KEY(run_id, interaction_id)
      );
      CREATE INDEX IF NOT EXISTS interactions_pending ON interactions(run_id, status);
    `
  },
  {
    version: 3,
    sql: `CREATE INDEX IF NOT EXISTS runs_session_workspace ON runs(session_id, workspace_id);`
  }
]

function schemaVersion(db) {
  const value = db.prepare('PRAGMA user_version').get()?.user_version
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_JOURNAL_VERSION')
  return value
}

/**
 * Applies each journal migration in its own immediate transaction. A failed
 * migration never advances user_version, so a restart cannot mistake a partly
 * created table for a completed handover.
 */
export function migrateJournalSchema(db) {
  let version = schemaVersion(db)
  if (version > LATEST_JOURNAL_SCHEMA_VERSION) throw new Error('UNSUPPORTED_JOURNAL_VERSION')
  for (const migration of migrations) {
    if (migration.version <= version) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      db.exec(`PRAGMA user_version=${migration.version}`)
      db.exec('COMMIT')
      version = migration.version
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The original schema error is the actionable failure.
      }
      throw error
    }
  }
}
