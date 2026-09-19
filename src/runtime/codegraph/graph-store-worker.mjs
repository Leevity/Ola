import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'

const db = new DatabaseSync(workerData.path)
if (workerData.path !== ':memory:') chmodSync(workerData.path, 0o600)
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL,
  indexed_at INTEGER NOT NULL, has_parse_error INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY, file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL, end_line INTEGER NOT NULL, end_column INTEGER NOT NULL,
  exported INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS references_index (
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  PRIMARY KEY (file_path, name, start_line, start_column)
);
CREATE TABLE IF NOT EXISTS imports (
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  source TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  PRIMARY KEY (file_path, source, start_line, start_column)
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_path, start_line, start_column);
CREATE INDEX IF NOT EXISTS references_name ON references_index(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS references_file ON references_index(file_path, start_line, start_column);
CREATE INDEX IF NOT EXISTS imports_file ON imports(file_path, start_line, start_column);
CREATE INDEX IF NOT EXISTS imports_source ON imports(source COLLATE NOCASE);
PRAGMA user_version=3;
COMMIT;`)

function validString(value, maximum = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}
function replaceFile(input) {
  if (
    !input ||
    !validString(input.path) ||
    !validString(input.contentHash, 128) ||
    !validString(input.language, 64)
  )
    throw new Error('INVALID_CODEGRAPH_FILE')
  if (!Array.isArray(input.symbols) || input.symbols.length > 100000)
    throw new Error('INVALID_CODEGRAPH_SYMBOLS')
  if (!Array.isArray(input.imports) || input.imports.length > 100000)
    throw new Error('INVALID_CODEGRAPH_IMPORTS')
  if (!Array.isArray(input.references) || input.references.length > 100000)
    throw new Error('INVALID_CODEGRAPH_REFERENCES')
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM files WHERE path=?').run(input.path)
    db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(
      input.path,
      input.contentHash,
      input.language,
      now,
      input.hasParseError ? 1 : 0
    )
    const insert = db.prepare('INSERT INTO symbols VALUES(?,?,?,?,?,?,?,?,?)')
    for (const symbol of input.symbols) {
      if (
        !symbol ||
        !validString(symbol.id, 512) ||
        !validString(symbol.name, 1024) ||
        !validString(symbol.kind, 64) ||
        !Number.isInteger(symbol.startLine) ||
        !Number.isInteger(symbol.startColumn) ||
        !Number.isInteger(symbol.endLine) ||
        !Number.isInteger(symbol.endColumn)
      )
        throw new Error('INVALID_CODEGRAPH_SYMBOL')
      insert.run(
        symbol.id,
        input.path,
        symbol.name,
        symbol.kind,
        symbol.startLine,
        symbol.startColumn,
        symbol.endLine,
        symbol.endColumn,
        symbol.exported ? 1 : 0
      )
    }
    const insertReference = db.prepare('INSERT INTO references_index VALUES(?,?,?,?,?,?)')
    for (const reference of input.references) {
      if (
        !reference ||
        !validString(reference.name, 1024) ||
        !Number.isInteger(reference.startLine) ||
        !Number.isInteger(reference.startColumn) ||
        !Number.isInteger(reference.endLine) ||
        !Number.isInteger(reference.endColumn)
      )
        throw new Error('INVALID_CODEGRAPH_REFERENCE')
      insertReference.run(
        input.path,
        reference.name,
        reference.startLine,
        reference.startColumn,
        reference.endLine,
        reference.endColumn
      )
    }
    const insertImport = db.prepare('INSERT INTO imports VALUES(?,?,?,?,?,?)')
    for (const imported of input.imports) {
      if (
        !imported ||
        !validString(imported.source, 4096) ||
        !Number.isInteger(imported.startLine) ||
        !Number.isInteger(imported.startColumn) ||
        !Number.isInteger(imported.endLine) ||
        !Number.isInteger(imported.endColumn)
      )
        throw new Error('INVALID_CODEGRAPH_IMPORT')
      insertImport.run(
        input.path,
        imported.source,
        imported.startLine,
        imported.startColumn,
        imported.endLine,
        imported.endColumn
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return {
    indexedAt: now,
    symbolCount: input.symbols.length,
    referenceCount: input.references.length
  }
}
function findSymbols(input) {
  if (!input || !validString(input.name, 1024)) throw new Error('INVALID_CODEGRAPH_QUERY')
  const limit = Math.min(1000, Math.max(1, Math.trunc(input.limit ?? 100)))
  const rows = db
    .prepare(
      `SELECT s.*, f.language, f.content_hash, f.has_parse_error
    FROM symbols s JOIN files f ON f.path=s.file_path
    WHERE s.name = ? COLLATE NOCASE ORDER BY s.file_path, s.start_line, s.start_column LIMIT ?`
    )
    .all(input.name, limit)
  return rows.map((row) => ({
    id: row.id,
    path: row.file_path,
    name: row.name,
    kind: row.kind,
    language: row.language,
    contentHash: row.content_hash,
    hasParseError: Boolean(row.has_parse_error),
    startLine: row.start_line,
    startColumn: row.start_column,
    endLine: row.end_line,
    endColumn: row.end_column,
    exported: Boolean(row.exported)
  }))
}
function searchSymbols(input) {
  if (!input || !validString(input.query, 1024)) throw new Error('INVALID_CODEGRAPH_QUERY')
  const limit = Math.min(1000, Math.max(1, Math.trunc(input.limit ?? 100)))
  // Search is literal, not a user-controlled SQL pattern. This matches the
  // renderer's identifier-search expectation and keeps `%` / `_` harmless.
  const escaped = input.query.replace(/[\\%_]/g, (character) => `\\${character}`)
  const rows = db
    .prepare(
      `SELECT s.*, f.language, f.content_hash, f.has_parse_error
       FROM symbols s JOIN files f ON f.path=s.file_path
       WHERE s.name LIKE ? ESCAPE '\\' COLLATE NOCASE
       ORDER BY s.file_path, s.start_line, s.start_column LIMIT ?`
    )
    .all(`%${escaped}%`, limit)
  return rows.map((row) => ({
    id: row.id,
    path: row.file_path,
    name: row.name,
    kind: row.kind,
    language: row.language,
    contentHash: row.content_hash,
    hasParseError: Boolean(row.has_parse_error),
    startLine: row.start_line,
    startColumn: row.start_column,
    endLine: row.end_line,
    endColumn: row.end_column,
    exported: Boolean(row.exported)
  }))
}
function getFile(path) {
  if (!validString(path)) throw new Error('INVALID_CODEGRAPH_FILE')
  const file = db.prepare('SELECT * FROM files WHERE path=?').get(path)
  if (!file) return null
  return {
    path: file.path,
    contentHash: file.content_hash,
    language: file.language,
    indexedAt: file.indexed_at,
    hasParseError: Boolean(file.has_parse_error),
    symbols: db
      .prepare('SELECT * FROM symbols WHERE file_path=? ORDER BY start_line,start_column,name')
      .all(path)
      .map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        startLine: row.start_line,
        startColumn: row.start_column,
        endLine: row.end_line,
        endColumn: row.end_column,
        exported: Boolean(row.exported)
      })),
    imports: getImports(path),
    references: getReferencesForFile(path)
  }
}
function getReferencesForFile(path) {
  if (!validString(path)) throw new Error('INVALID_CODEGRAPH_FILE')
  return db
    .prepare(
      'SELECT name, start_line, start_column, end_line, end_column FROM references_index WHERE file_path=? ORDER BY start_line,start_column,name'
    )
    .all(path)
    .map((row) => ({
      name: row.name,
      startLine: row.start_line,
      startColumn: row.start_column,
      endLine: row.end_line,
      endColumn: row.end_column
    }))
}
function findReferences(input) {
  if (!input || !validString(input.name, 1024)) throw new Error('INVALID_CODEGRAPH_QUERY')
  const limit = Math.min(1000, Math.max(1, Math.trunc(input.limit ?? 100)))
  return db
    .prepare(
      `SELECT r.*, f.language FROM references_index r JOIN files f ON f.path=r.file_path
       WHERE r.name = ? COLLATE NOCASE ORDER BY r.file_path, r.start_line, r.start_column LIMIT ?`
    )
    .all(input.name, limit)
    .map((row) => ({
      path: row.file_path,
      language: row.language,
      name: row.name,
      startLine: row.start_line,
      startColumn: row.start_column,
      endLine: row.end_line,
      endColumn: row.end_column
    }))
}
function getImports(path) {
  if (!validString(path)) throw new Error('INVALID_CODEGRAPH_FILE')
  return db
    .prepare(
      'SELECT source, start_line, start_column, end_line, end_column FROM imports WHERE file_path=? ORDER BY start_line,start_column,source'
    )
    .all(path)
    .map((row) => ({
      source: row.source,
      startLine: row.start_line,
      startColumn: row.start_column,
      endLine: row.end_line,
      endColumn: row.end_column
    }))
}
function listPaths() {
  return db
    .prepare('SELECT path FROM files ORDER BY path')
    .all()
    .map((row) => row.path)
}
function removeFile(input) {
  if (!input || !validString(input.path)) throw new Error('INVALID_CODEGRAPH_FILE')
  const result = db.prepare('DELETE FROM files WHERE path=?').run(input.path)
  return result.changes > 0
}
function dispatch(method, args) {
  if (method === 'replace-file') return replaceFile(args)
  if (method === 'find-symbols') return findSymbols(args)
  if (method === 'search-symbols') return searchSymbols(args)
  if (method === 'get-file') return getFile(args.path)
  if (method === 'list-paths') return listPaths()
  if (method === 'remove-file') return removeFile(args)
  if (method === 'get-imports') return getImports(args.path)
  if (method === 'find-references') return findReferences(args)
  if (method === 'close') {
    db.close()
    return null
  }
  throw new Error('UNKNOWN_CODEGRAPH_COMMAND')
}
parentPort.on('message', ({ id, method, args }) => {
  try {
    parentPort.postMessage({ id, result: dispatch(method, args) })
  } catch (error) {
    parentPort.postMessage({ id, error: error.message })
  }
  if (method === 'close') parentPort.close()
})
