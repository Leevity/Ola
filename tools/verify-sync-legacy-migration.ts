import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('sidecars/Ola.Native.Worker/Modules/Db/DbSchemaMigrator.cs', 'utf8')

assert.match(source, /PreserveLegacySyncTable\(connection, transaction, "sync_record_state"\)/)
assert.match(source, /PreserveLegacySyncTable\(connection, transaction, "sync_tombstones"\)/)
assert.match(
  source,
  /ALTER TABLE \{QuoteIdent\(tableName\)\} RENAME TO \{QuoteIdent\(backupTableName\)\}/
)
assert.match(source, /sync-record-key-backup-v1:\{tableName\}/)
assert.match(source, /using var transaction = connection\.BeginTransaction\(\)/)
assert.match(source, /transaction\.Commit\(\)/)
assert.doesNotMatch(source, /DROP TABLE IF EXISTS sync_record_state/)
assert.doesNotMatch(source, /DROP TABLE IF EXISTS sync_tombstones/)

console.log('sync legacy migration verification passed')
