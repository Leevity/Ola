import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { migrateBusinessSchema } from './business-schema.mjs'

async function verifiedHandoverPath() {
  if (typeof workerData.path !== 'string' || typeof workerData.handoverManifestPath !== 'string')
    throw new Error('BUSINESS_HANDOVER_MANIFEST_REQUIRED')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(workerData.handoverManifestPath, 'utf8'))
  } catch {
    throw new Error('BUSINESS_HANDOVER_MANIFEST_INVALID')
  }
  const backupPath = resolve(workerData.path)
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    typeof manifest.backupPath !== 'string' ||
    typeof manifest.rollbackPath !== 'string' ||
    typeof manifest.rollbackSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.rollbackSha256) ||
    !Number.isSafeInteger(manifest.rollbackSize) ||
    typeof manifest.sourcePath !== 'string' ||
    typeof manifest.createdAt !== 'string' ||
    !Array.isArray(manifest.tables) ||
    resolve(manifest.backupPath) !== backupPath ||
    resolve(workerData.handoverManifestPath) !== `${backupPath}.manifest.json` ||
    resolve(manifest.sourcePath) === backupPath ||
    resolve(manifest.rollbackPath) !== `${backupPath}.rollback.db`
  )
    throw new Error('BUSINESS_HANDOVER_MANIFEST_INVALID')
  let backupStat
  try {
    backupStat = lstatSync(backupPath, { bigint: true })
  } catch {
    throw new Error('BUSINESS_HANDOVER_BACKUP_UNSAFE')
  }
  if (
    !backupStat.isFile() ||
    backupStat.isSymbolicLink() ||
    (process.platform !== 'win32' && (backupStat.mode & 0o077n) !== 0n)
  )
    throw new Error('BUSINESS_HANDOVER_BACKUP_UNSAFE')
  let sourceStat
  try {
    sourceStat = statSync(manifest.sourcePath, { bigint: true })
  } catch {
    // A completed handover can outlive its source database.
  }
  if (
    sourceStat &&
    backupStat.ino > 0n &&
    backupStat.dev === sourceStat.dev &&
    backupStat.ino === sourceStat.ino
  )
    throw new Error('BUSINESS_HANDOVER_BACKUP_UNSAFE')
  let rollbackStat
  try {
    rollbackStat = lstatSync(manifest.rollbackPath, { bigint: true })
  } catch {
    throw new Error('BUSINESS_HANDOVER_ROLLBACK_UNAVAILABLE')
  }
  if (
    !rollbackStat.isFile() ||
    rollbackStat.isSymbolicLink() ||
    (process.platform === 'win32'
      ? (rollbackStat.mode & 0o222n) !== 0n
      : (rollbackStat.mode & 0o377n) !== 0n) ||
    rollbackStat.size !== BigInt(manifest.rollbackSize)
  )
    throw new Error('BUSINESS_HANDOVER_ROLLBACK_UNSAFE')
  if (
    rollbackStat.ino > 0n &&
    ((rollbackStat.dev === backupStat.dev && rollbackStat.ino === backupStat.ino) ||
      (sourceStat && rollbackStat.dev === sourceStat.dev && rollbackStat.ino === sourceStat.ino))
  )
    throw new Error('BUSINESS_HANDOVER_ROLLBACK_UNSAFE')
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(manifest.rollbackPath)) digest.update(chunk)
  if (digest.digest('hex') !== manifest.rollbackSha256)
    throw new Error('BUSINESS_HANDOVER_ROLLBACK_MISMATCH')
  let originalPath
  try {
    originalPath = realpathSync(manifest.sourcePath)
  } catch {
    // The original source can be gone after handover.
  }
  if (originalPath === realpathSync(backupPath)) throw new Error('BUSINESS_HANDOVER_BACKUP_UNSAFE')
  return backupPath
}

async function resolveDatabasePath() {
  if (workerData.mode === 'direct') {
    if (typeof workerData.path !== 'string' || !isAbsolute(workerData.path))
      throw new Error('BUSINESS_DATABASE_PATH_REQUIRED')
    return resolve(workerData.path)
  }
  return await verifiedHandoverPath()
}

const databasePath = await resolveDatabasePath()
let lease
try {
  lease = new DatabaseSync(`${databasePath}.ola-ts-writer.lock`)
  chmodSync(`${databasePath}.ola-ts-writer.lock`, 0o600)
  lease.exec(
    'PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE'
  )
} catch {
  lease?.close()
  throw new Error('BUSINESS_DATABASE_LOCKED')
}
const db = new DatabaseSync(databasePath)
chmodSync(databasePath, 0o600)
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
migrateBusinessSchema(db, { direct: workerData.mode === 'direct' })

const CRON_JOB_COLUMNS = `id,name,schedule_kind,schedule_at,schedule_every,schedule_expr,schedule_tz,prompt,
  agent_id,model,model_source,working_folder,ssh_connection_id,session_id,
  source_session_title,source_project_id,source_project_name,source_provider_id,
  delivery_mode,delivery_target,plugin_id,plugin_chat_id,enabled,delete_after_run,
  max_iterations,deleted_at,last_fired_at,fire_count,created_at,updated_at,workspace_id`

const RUNTIME_JOB_COLUMNS = `job_id AS jobId,workspace_id AS workspaceId,run_id AS runId,
  session_id AS sessionId,method,state,idempotency_key AS idempotencyKey,
  lane_key AS laneKey,error_code AS errorCode,error_message AS errorMessage,
  created_at AS createdAt,updated_at AS updatedAt,finished_at AS finishedAt`

function runtimeJob(jobId, workspaceId) {
  return (
    db
      .prepare(`SELECT ${RUNTIME_JOB_COLUMNS} FROM runtime_jobs WHERE job_id=? AND workspace_id=?`)
      .get(jobId, workspaceId) ?? null
  )
}

function runtimeJobWorkspace(sessionId, requestedWorkspaceId) {
  if (!sessionId) {
    if (requestedWorkspaceId !== 'local-personal')
      throw new Error('BUSINESS_RUNTIME_JOB_SESSION_REQUIRED')
    return requestedWorkspaceId
  }
  const owner = db
    .prepare('SELECT workspace_id FROM sessions WHERE id=?')
    .get(sessionId)?.workspace_id
  if (owner && owner !== requestedWorkspaceId)
    throw new Error('BUSINESS_RUNTIME_JOB_SESSION_WORKSPACE_MISMATCH')
  if (!owner && requestedWorkspaceId !== 'local-personal')
    throw new Error('BUSINESS_RUNTIME_JOB_SESSION_REQUIRED')
  return owner ?? requestedWorkspaceId
}

function saveDrawRun(args) {
  const workspaceId = text(args.workspaceId, 'WORKSPACE')
  const id = text(args.id, 'DRAW_RUN')
  const owner = db.prepare('SELECT workspace_id FROM draw_runs WHERE id=?').get(id)
  if (owner && owner.workspace_id !== workspaceId)
    throw new Error('BUSINESS_DRAW_WORKSPACE_MISMATCH')
  db.prepare(
    `INSERT INTO draw_runs (
      id,workspace_id,prompt,provider_name,model_name,mode,meta_json,created_at,
      is_generating,images_json,error_json,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      prompt=excluded.prompt,provider_name=excluded.provider_name,
      model_name=excluded.model_name,mode=excluded.mode,meta_json=excluded.meta_json,
      is_generating=excluded.is_generating,images_json=excluded.images_json,
      error_json=excluded.error_json,updated_at=excluded.updated_at`
  ).run(
    id,
    workspaceId,
    memoryContent(args.prompt, 'DRAW_PROMPT'),
    text(args.providerName, 'DRAW_PROVIDER'),
    text(args.modelName, 'DRAW_MODEL'),
    text(args.mode ?? 'image', 'DRAW_MODE'),
    args.metaJson == null ? null : cronJson(args.metaJson, 'DRAW_META'),
    timestamp(args.createdAt, 'CREATED_AT'),
    args.isGenerating ? 1 : 0,
    cronJson(args.imagesJson ?? '[]', 'DRAW_IMAGES'),
    args.errorJson == null ? null : cronJson(args.errorJson, 'DRAW_ERROR'),
    timestamp(args.updatedAt, 'UPDATED_AT')
  )
  return true
}

function workspaceDrawSyncState(scopeHash, workspaceId, providerId) {
  const rows = db
    .prepare(
      `SELECT id,workspace_id,prompt,provider_name,model_name,mode,meta_json,
       created_at,is_generating,images_json,error_json,updated_at FROM draw_runs
       WHERE workspace_id=? ORDER BY created_at DESC,id DESC`
    )
    .all(workspaceId)
  const baseline = db
    .prepare(
      `SELECT domain,record_id AS recordId,content_hash AS contentHash
       FROM ola_ts_sync_baselines_v2
       WHERE scope_hash=? AND workspace_id=? AND provider_id=? AND domain='db:draw_runs'
       ORDER BY record_id`
    )
    .all(scopeHash, workspaceId, providerId)
  const storedTombstones = db
    .prepare(
      `SELECT domain,record_id AS recordId,deleted_at AS deletedAt,
              origin_device_id AS originDeviceId,workspace_id AS workspaceId
       FROM ola_ts_sync_tombstones_v2
       WHERE scope_hash=? AND workspace_id=? AND provider_id=? AND domain='db:draw_runs'
       ORDER BY record_id`
    )
    .all(scopeHash, workspaceId, providerId)
  return {
    rows,
    baseline,
    storedTombstones,
    revisionToken: createHash('sha256')
      .update(JSON.stringify([rows, baseline, storedTombstones]))
      .digest('hex')
  }
}

const SYNC_DOMAIN_PREFIX = 'db:'

function syncQuoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function syncJsonValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return Number(value)
  if (Buffer.isBuffer(value)) return value.toString('base64')
  return value
}

function syncSqlValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

function syncTableSchemas() {
  const names = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
    .all()
    .map((row) => String(row.name))
    .filter((name) => !name.startsWith('sync_') && !name.startsWith('ola_ts_'))
  return names
    .map((name) => {
      const columns = db
        .prepare(`PRAGMA table_info(${syncQuoteIdentifier(name)})`)
        .all()
        .map((row) => ({ name: String(row.name), pk: Number(row.pk) }))
      const pk = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk)
      if (pk.length === 0) return null
      const dependencies = db
        .prepare(`PRAGMA foreign_key_list(${syncQuoteIdentifier(name)})`)
        .all()
        .map((row) => String(row.table))
      return {
        name,
        columns: columns.map((column) => column.name),
        pk: pk.map((column) => column.name),
        dependencies
      }
    })
    .filter(Boolean)
}

function assertLegacySyncPersonalOnly(schemas) {
  for (const schema of schemas) {
    if (!schema.columns.includes('workspace_id')) continue
    const row = db
      .prepare(
        `SELECT 1 AS present FROM ${syncQuoteIdentifier(schema.name)} WHERE workspace_id IS NULL OR workspace_id <> 'local-personal' LIMIT 1`
      )
      .get()
    if (row) throw new Error('LEGACY_SYNC_TEAM_WORKSPACE_UNSUPPORTED')
  }
}

function syncRecordId(values) {
  return JSON.stringify(values.map((value) => syncJsonValue(value)))
}

function syncParseRecordId(recordId) {
  const parsed = JSON.parse(recordId)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function syncTableFromDomain(domain) {
  return typeof domain === 'string' && domain.startsWith(SYNC_DOMAIN_PREFIX)
    ? domain.slice(SYNC_DOMAIN_PREFIX.length)
    : null
}

function syncTableOrder(schemas) {
  const byName = new Map(schemas.map((schema) => [schema.name, schema]))
  const visiting = new Set()
  const visited = new Set()
  const ordered = []
  const visit = (name) => {
    if (visited.has(name) || visiting.has(name)) return
    visiting.add(name)
    for (const dependency of byName.get(name)?.dependencies ?? []) {
      if (byName.has(dependency)) visit(dependency)
    }
    visiting.delete(name)
    visited.add(name)
    ordered.push(name)
  }
  for (const schema of schemas) visit(schema.name)
  return ordered
}

// V2 workspace sync is intentionally allow-listed. Device-global tables (provider
// health, migrations, SSH connection catalogues, etc.) never enter a workspace bundle.
const WORKSPACE_SYNC_TABLES = new Set([
  'sessions',
  'messages',
  'projects',
  'plans',
  'session_goals',
  'session_goal_events',
  'cron_jobs',
  'cron_runs',
  'cron_run_messages',
  'cron_run_logs',
  'tasks',
  'memory_roots',
  'memory_stage1_outputs',
  'memory_jobs',
  'memory_automation_entries',
  'memory_automation_rollups_v2',
  'memory_citation_usage',
  'usage_events',
  'usage_activity_daily_v2',
  'usage_activity_daily_models_v2',
  'usage_activity_daily_providers_v2',
  'draw_runs',
  'agent_change_sets',
  'agent_file_changes',
  'sub_agent_history',
  'runtime_tool_results',
  'runtime_jobs',
  'runtime_job_events',
  'qq_wakeup_windows_v2',
  'wiki_documents',
  'wiki_nodes',
  'wiki_file_snapshots',
  'wiki_generation_runs',
  'desktop_flows',
  'desktop_flow_steps',
  'desktop_flow_runs'
])

function workspaceSyncSchemas() {
  const schemas = syncTableSchemas().filter((schema) => WORKSPACE_SYNC_TABLES.has(schema.name))
  if (schemas.length !== WORKSPACE_SYNC_TABLES.size)
    throw new Error('BUSINESS_SYNC_SCHEMA_INCOMPLETE')
  return schemas
}

function workspaceSyncOwner(schemaName, workspaceId) {
  const direct = new Set([
    'sessions',
    'projects',
    'cron_jobs',
    'qq_wakeup_windows_v2',
    'wiki_documents',
    'wiki_nodes',
    'wiki_file_snapshots',
    'wiki_generation_runs',
    'memory_roots',
    'memory_jobs',
    'memory_automation_entries',
    'memory_automation_rollups_v2',
    'usage_events',
    'usage_activity_daily_v2',
    'usage_activity_daily_models_v2',
    'usage_activity_daily_providers_v2',
    'draw_runs',
    'agent_change_sets',
    'runtime_jobs',
    'desktop_flows'
  ])
  if (direct.has(schemaName)) return { sql: 'workspace_id=?', params: [workspaceId] }
  const bySession = new Set([
    'messages',
    'plans',
    'session_goals',
    'session_goal_events',
    'tasks',
    'sub_agent_history',
    'runtime_tool_results'
  ])
  if (bySession.has(schemaName))
    return {
      sql: `session_id IN (SELECT id FROM sessions WHERE workspace_id=?)`,
      params: [workspaceId]
    }
  if (schemaName === 'cron_runs')
    return {
      sql: 'job_id IN (SELECT id FROM cron_jobs WHERE workspace_id=?)',
      params: [workspaceId]
    }
  if (schemaName === 'cron_run_messages' || schemaName === 'cron_run_logs')
    return {
      sql: `run_id IN (SELECT r.id FROM cron_runs r JOIN cron_jobs j ON j.id=r.job_id WHERE j.workspace_id=?)`,
      params: [workspaceId]
    }
  if (schemaName === 'memory_stage1_outputs' || schemaName === 'memory_citation_usage')
    return {
      sql: `memory_root_id IN (SELECT id FROM memory_roots WHERE workspace_id=?)`,
      params: [workspaceId]
    }
  if (schemaName === 'agent_file_changes')
    return {
      sql: `run_id IN (SELECT run_id FROM agent_change_sets WHERE workspace_id=?)`,
      params: [workspaceId]
    }
  if (schemaName === 'runtime_job_events')
    return {
      sql: `job_id IN (SELECT job_id FROM runtime_jobs WHERE workspace_id=?)`,
      params: [workspaceId]
    }
  if (schemaName === 'desktop_flow_steps' || schemaName === 'desktop_flow_runs')
    return {
      sql: `flow_id IN (SELECT id FROM desktop_flows WHERE workspace_id=?)`,
      params: [workspaceId]
    }
  throw new Error(`BUSINESS_SYNC_TABLE_UNSUPPORTED:${schemaName}`)
}

function workspaceSyncRecordId(schema, row) {
  return syncRecordId(schema.pk.map((column) => row[column]))
}

function workspaceSyncRevision(rows, baseline, tombstones) {
  return createHash('sha256')
    .update(JSON.stringify([rows, baseline, tombstones]))
    .digest('hex')
}

function workspaceSyncStableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(workspaceSyncStableStringify).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${workspaceSyncStableStringify(value[key])}`)
    .join(',')}}`
}

function workspaceSyncHash(value) {
  return createHash('sha256').update(workspaceSyncStableStringify(value)).digest('hex')
}

function workspaceSyncKey(domain, recordId) {
  return `${domain}\u0000${recordId}`
}

function workspaceSyncState(scopeHash, workspaceId, providerId, schemas) {
  const rows = []
  for (const schema of schemas) {
    const owner = workspaceSyncOwner(schema.name, workspaceId)
    const selected = db
      .prepare(
        `SELECT * FROM ${syncQuoteIdentifier(schema.name)} WHERE ${owner.sql} ORDER BY ${schema.pk.map(syncQuoteIdentifier).join(', ')}`
      )
      .all(...owner.params)
    for (const row of selected) {
      const normalized = Object.fromEntries(
        schema.columns.map((column) => [column, syncJsonValue(row[column])])
      )
      const updatedAt =
        typeof normalized.updated_at === 'number'
          ? normalized.updated_at
          : typeof normalized.created_at === 'number'
            ? normalized.created_at
            : null
      const record = {
        domain: `${SYNC_DOMAIN_PREFIX}${schema.name}`,
        recordId: workspaceSyncRecordId(schema, normalized),
        value: { table: schema.name, row: normalized },
        updatedAt
      }
      if (!schema.columns.includes('workspace_id')) record.workspaceId = workspaceId
      rows.push(record)
    }
  }
  const baseline = db
    .prepare(
      'SELECT domain,record_id AS recordId,content_hash AS contentHash FROM ola_ts_sync_baselines_v2 WHERE scope_hash=? AND workspace_id=? AND provider_id=?'
    )
    .all(scopeHash, workspaceId, providerId)
  const tombstones = db
    .prepare(
      'SELECT domain,record_id AS recordId,deleted_at AS deletedAt,origin_device_id AS originDeviceId,workspace_id AS workspaceId FROM ola_ts_sync_tombstones_v2 WHERE scope_hash=? AND workspace_id=? AND provider_id=?'
    )
    .all(scopeHash, workspaceId, providerId)
  return {
    rows,
    baseline,
    tombstones,
    revisionToken: workspaceSyncRevision(rows, baseline, tombstones)
  }
}

function syncCaptureLocal(providerId) {
  const schemas = syncTableSchemas()
  assertLegacySyncPersonalOnly(schemas)
  const records = []
  for (const schema of schemas) {
    const rows = db
      .prepare(
        `SELECT * FROM ${syncQuoteIdentifier(schema.name)} ORDER BY ${schema.pk.map(syncQuoteIdentifier).join(', ')}`
      )
      .all()
    for (const row of rows) {
      const normalized = Object.fromEntries(
        schema.columns.map((column) => [column, syncJsonValue(row[column])])
      )
      const updatedAt =
        typeof normalized.updated_at === 'number'
          ? normalized.updated_at
          : typeof normalized.created_at === 'number'
            ? normalized.created_at
            : null
      records.push({
        domain: `${SYNC_DOMAIN_PREFIX}${schema.name}`,
        recordId: syncRecordId(schema.pk.map((column) => normalized[column])),
        value: { table: schema.name, row: normalized },
        updatedAt
      })
    }
  }
  const baseline = db
    .prepare(
      'SELECT domain,record_id AS recordId,content_hash AS contentHash FROM sync_record_state WHERE provider_id=?'
    )
    .all(providerId)
  const tombstones = db
    .prepare(
      'SELECT domain,record_id AS recordId,deleted_at AS deletedAt,origin_device_id AS originDeviceId FROM sync_tombstones WHERE provider_id=?'
    )
    .all(providerId)
  return { records, baseline, tombstones }
}

function syncApplyDbMerge(input) {
  const schemas = syncTableSchemas()
  assertLegacySyncPersonalOnly(schemas)
  const byName = new Map(schemas.map((schema) => [schema.name, schema]))
  const order = syncTableOrder(schemas)
  const orderIndex = new Map(order.map((name, index) => [name, index]))
  const records = Array.isArray(input.recordsToApply) ? input.recordsToApply : []
  const deletes = Array.isArray(input.recordsToDelete) ? input.recordsToDelete : []
  for (const record of records) {
    const row = record?.value?.row
    if (row && row.workspace_id !== undefined && row.workspace_id !== 'local-personal')
      throw new Error('LEGACY_SYNC_TEAM_WORKSPACE_UNSUPPORTED')
  }
  let changed = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    const sortedDeletes = [...deletes].sort(
      (a, b) =>
        (orderIndex.get(syncTableFromDomain(b.domain)) ?? 20000) -
        (orderIndex.get(syncTableFromDomain(a.domain)) ?? 20000)
    )
    for (const tombstone of sortedDeletes) {
      const schema = byName.get(syncTableFromDomain(tombstone.domain))
      if (!schema) continue
      const values = syncParseRecordId(tombstone.recordId)
      if (values.length !== schema.pk.length)
        throw new Error(`Invalid record id for ${schema.name}`)
      const where = schema.pk.map((column) => `${syncQuoteIdentifier(column)} IS ?`).join(' AND ')
      changed += db
        .prepare(`DELETE FROM ${syncQuoteIdentifier(schema.name)} WHERE ${where}`)
        .run(...values).changes
    }
    const sortedRecords = [...records].sort(
      (a, b) =>
        (orderIndex.get(syncTableFromDomain(a.domain)) ?? 20000) -
        (orderIndex.get(syncTableFromDomain(b.domain)) ?? 20000)
    )
    for (const record of sortedRecords) {
      const schema = byName.get(syncTableFromDomain(record.domain))
      const row = record?.value?.row
      if (!schema || !row || typeof row !== 'object') continue
      const columns = schema.columns
      const placeholders = columns.map(() => '?').join(',')
      const conflict = schema.pk.map(syncQuoteIdentifier).join(',')
      const updates = columns
        .filter((column) => !schema.pk.includes(column))
        .map((column) => `${syncQuoteIdentifier(column)}=excluded.${syncQuoteIdentifier(column)}`)
      const sql = `INSERT INTO ${syncQuoteIdentifier(schema.name)} (${columns.map(syncQuoteIdentifier).join(',')}) VALUES (${placeholders}) ON CONFLICT(${conflict}) DO ${updates.length ? `UPDATE SET ${updates.join(',')}` : 'NOTHING'}`
      changed += db.prepare(sql).run(...columns.map((column) => syncSqlValue(row[column]))).changes
    }
    db.exec('COMMIT')
    return { success: true, changed }
  } catch (error) {
    db.exec('ROLLBACK')
    return {
      success: false,
      changed: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function syncSaveMetadata(input) {
  const providerId = text(input.providerId, 'SYNC_PROVIDER')
  const records = Array.isArray(input.records) ? input.records : []
  const tombstones = Array.isArray(input.tombstones) ? input.tombstones : []
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM sync_record_state WHERE provider_id=?').run(providerId)
    db.prepare('DELETE FROM sync_tombstones WHERE provider_id=?').run(providerId)
    const state = db.prepare(
      'INSERT INTO sync_record_state(provider_id,domain,record_id,content_hash,synced_at) VALUES(?,?,?,?,?)'
    )
    for (const record of records)
      state.run(providerId, record.domain, record.recordId, record.hash, Date.now())
    const tombstone = db.prepare(
      'INSERT INTO sync_tombstones(provider_id,domain,record_id,deleted_at,origin_device_id) VALUES(?,?,?,?,?)'
    )
    for (const item of tombstones)
      tombstone.run(providerId, item.domain, item.recordId, item.deletedAt, item.originDeviceId)
    db.exec('COMMIT')
    return { success: true, changed: records.length + tombstones.length }
  } catch (error) {
    db.exec('ROLLBACK')
    return {
      success: false,
      changed: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function drawRowValues(row) {
  return [
    row.id,
    row.workspace_id,
    row.prompt,
    row.provider_name,
    row.model_name,
    row.mode,
    row.meta_json,
    row.created_at,
    row.is_generating,
    row.images_json,
    row.error_json,
    row.updated_at
  ]
}

function equalDrawRows(actual, expected) {
  if (!Array.isArray(expected) || actual.length !== expected.length) return false
  const sort = (left, right) => String(left.id).localeCompare(String(right.id))
  return (
    JSON.stringify([...actual].sort(sort).map(drawRowValues)) ===
    JSON.stringify([...expected].sort(sort).map(drawRowValues))
  )
}

const USAGE_EVENT_COLUMNS = [
  'id',
  'created_at',
  'request_started_at',
  'request_finished_at',
  'session_id',
  'message_id',
  'project_id',
  'source_kind',
  'provider_id',
  'provider_name',
  'provider_type',
  'provider_builtin_id',
  'provider_base_url',
  'model_id',
  'model_name',
  'model_category',
  'request_type',
  'input_tokens',
  'billable_input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'reasoning_tokens',
  'context_tokens',
  'input_price',
  'output_price',
  'cache_creation_price',
  'cache_hit_price',
  'input_cost_usd',
  'output_cost_usd',
  'cache_creation_cost_usd',
  'cache_hit_cost_usd',
  'total_cost_usd',
  'ttft_ms',
  'total_ms',
  'tps',
  'provider_response_id',
  'request_debug_json',
  'usage_raw_json',
  'meta_json',
  'workspace_id'
]

const USAGE_INTEGER_COLUMNS = new Set([
  'created_at',
  'request_started_at',
  'request_finished_at',
  'input_tokens',
  'billable_input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'reasoning_tokens',
  'context_tokens'
])

const USAGE_REAL_COLUMNS = new Set([
  'input_price',
  'output_price',
  'cache_creation_price',
  'cache_hit_price',
  'input_cost_usd',
  'output_cost_usd',
  'cache_creation_cost_usd',
  'cache_hit_cost_usd',
  'total_cost_usd',
  'ttft_ms',
  'total_ms',
  'tps'
])

function text(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024)
    throw new Error(`INVALID_BUSINESS_${field}`)
  return value.trim()
}

function wikiProjectRoot(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 8192 ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    resolve(value) !== value
  )
    throw new Error('INVALID_BUSINESS_WIKI_PROJECT_ROOT')
  return value
}

function wikiStorageKey(projectRoot, workspaceId) {
  return workspaceId === 'local-personal'
    ? projectRoot
    : `workspace-wiki:${createHash('sha256')
        .update(JSON.stringify([workspaceId, projectRoot]))
        .digest('hex')}`
}

function page(value, fallback = 200, maximum = 2000) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum)
    throw new Error('INVALID_BUSINESS_PAGE')
  return resolved
}

function offset(value) {
  const resolved = value ?? 0
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 1_000_000)
    throw new Error('INVALID_BUSINESS_OFFSET')
  return resolved
}

function contextLimit(value, fallback, maximum = 5000) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved)) throw new Error('INVALID_BUSINESS_PAGE')
  return Math.min(Math.max(resolved, 1), maximum)
}

function searchQuery(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048)
    throw new Error('INVALID_BUSINESS_QUERY')
  return value.trim()
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => '\\' + character)
}

function timestamp(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_BUSINESS_${field}`)
  return value
}

function usageRange(args) {
  const from = timestamp(args.from, 'USAGE_FROM')
  const to = timestamp(args.to, 'USAGE_TO')
  if (to < from) throw new Error('INVALID_BUSINESS_USAGE_RANGE')
  return [from, to]
}

function usageFilter(args) {
  const workspaceId = text(args.workspaceId, 'WORKSPACE')
  const [from, to] = usageRange(args)
  const clauses = ['workspace_id=?', 'created_at>=?', 'created_at<=?']
  const values = [workspaceId, from, to]
  for (const [key, column] of [
    ['providerId', 'provider_id'],
    ['modelId', 'model_id'],
    ['sourceKind', 'source_kind']
  ]) {
    if (args[key] === undefined || args[key] === null || args[key] === '') continue
    clauses.push(`${column}=?`)
    values.push(text(args[key], `USAGE_${column.toUpperCase()}`))
  }
  return { clause: `WHERE ${clauses.join(' AND ')}`, values }
}

function usageSummaryColumns(includeLatency = true, includeReasoning = true) {
  const effective = `COALESCE(billable_input_tokens,
    MAX(input_tokens-COALESCE(cache_read_tokens,0)-COALESCE(cache_creation_tokens,0),0))`
  return `COUNT(*) AS request_count,
    COALESCE(SUM(${effective}),0) AS input_tokens,
    COALESCE(SUM(${effective}),0) AS billable_input_tokens,
    COALESCE(SUM(input_tokens),0) AS total_input_tokens,
    COALESCE(SUM(output_tokens),0) AS output_tokens,
    COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
    COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens${
      includeReasoning ? ',COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens' : ''
    },
    COALESCE(SUM(total_cost_usd),0) AS total_cost_usd${
      includeLatency ? ',AVG(ttft_ms) AS avg_ttft_ms,AVG(total_ms) AS avg_total_ms' : ''
    }`
}

function queryRawUsage(operation, args) {
  const { clause, values } = usageFilter(args)
  const summary = usageSummaryColumns(operation !== 'timeline', operation === 'overview')
  if (operation === 'overview')
    return { row: db.prepare(`SELECT ${summary} FROM usage_events ${clause}`).get(...values) }
  const date = `strftime('%Y-%m-%d',created_at/1000,'unixepoch','localtime')`
  let select
  let group
  let order
  if (operation === 'daily') {
    select = `${date} AS day`
    group = 'day'
    order = 'day DESC'
  } else if (operation === 'timeline') {
    select =
      args.bucket === 'hour'
        ? `strftime('%Y-%m-%d %H:00',created_at/1000,'unixepoch','localtime') AS bucket_label`
        : `${date} AS bucket_label`
    group = 'bucket_label'
    order = 'bucket_label DESC'
  } else if (operation === 'by-model') {
    select = 'model_id,model_name,provider_id,provider_name'
    group = select
    order = 'total_cost_usd DESC,request_count DESC'
  } else if (operation === 'by-provider') {
    select = 'provider_id,provider_name,provider_type,provider_builtin_id,provider_base_url'
    group = select
    order = 'total_cost_usd DESC,request_count DESC'
  } else {
    throw new Error('INVALID_BUSINESS_USAGE_OPERATION')
  }
  return {
    rows: db
      .prepare(
        `SELECT ${select},${summary} FROM usage_events ${clause}
        GROUP BY ${group} ORDER BY ${order}`
      )
      .all(...values)
  }
}

function queryActivityUsage(operation, args) {
  const workspaceId = text(args.workspaceId, 'WORKSPACE')
  const [from, to] = usageRange(args)
  const fromDay = db
    .prepare("SELECT strftime('%Y-%m-%d',?/1000,'unixepoch','localtime') AS day")
    .get(from).day
  const toDay = db
    .prepare("SELECT strftime('%Y-%m-%d',?/1000,'unixepoch','localtime') AS day")
    .get(to).day
  const filter = 'WHERE workspace_id=? AND day>=? AND day<=?'
  const values = [workspaceId, fromDay, toDay]
  const common = `COALESCE(SUM(request_count),0) AS request_count,
    COALESCE(SUM(input_tokens),0) AS input_tokens,
    COALESCE(SUM(input_tokens),0) AS billable_input_tokens,
    COALESCE(SUM(input_tokens+cache_creation_tokens+cache_read_tokens),0) AS total_input_tokens,
    COALESCE(SUM(output_tokens),0) AS output_tokens,
    COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
    COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
    COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
    COALESCE(SUM(total_cost_usd),0) AS total_cost_usd`
  if (operation === 'activity-overview')
    return {
      row: db
        .prepare(
          `SELECT ${common},NULL AS avg_ttft_ms,NULL AS avg_total_ms
        FROM usage_activity_daily_v2 ${filter}`
        )
        .get(...values)
    }
  if (operation === 'activity-daily')
    return {
      rows: db
        .prepare(
          `SELECT day,request_count,input_tokens,
        input_tokens AS billable_input_tokens,
        input_tokens+cache_creation_tokens+cache_read_tokens AS total_input_tokens,
        output_tokens,cache_creation_tokens,cache_read_tokens,reasoning_tokens,total_cost_usd,
        NULL AS avg_ttft_ms,NULL AS avg_total_ms
        FROM usage_activity_daily_v2 ${filter} ORDER BY day DESC`
        )
        .all(...values)
    }
  const requestedLimit = args.limit ?? 50
  const requestedOffset = args.offset ?? 0
  if (!Number.isSafeInteger(requestedLimit) || !Number.isSafeInteger(requestedOffset))
    throw new Error('INVALID_BUSINESS_USAGE_PAGE')
  const limit = Math.min(Math.max(requestedLimit, 1), 200)
  const skip = Math.max(requestedOffset, 0)
  const order = `ORDER BY COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0)+
    COALESCE(SUM(cache_creation_tokens),0)+COALESCE(SUM(cache_read_tokens),0) DESC,
    COALESCE(SUM(request_count),0) DESC LIMIT ? OFFSET ?`
  if (operation === 'activity-by-model')
    return {
      rows: db
        .prepare(
          `SELECT NULLIF(model_id,'') AS model_id,
        COALESCE(MAX(model_name),NULLIF(model_id,''),'-') AS model_name,
        NULLIF(provider_id,'') AS provider_id,
        COALESCE(MAX(provider_name),NULLIF(provider_id,''),'-') AS provider_name,
        ${common} FROM usage_activity_daily_models_v2 ${filter}
        GROUP BY model_id,provider_id ${order}`
        )
        .all(...values, limit, skip)
    }
  if (operation === 'activity-by-provider')
    return {
      rows: db
        .prepare(
          `SELECT NULLIF(provider_id,'') AS provider_id,
        COALESCE(MAX(provider_name),NULLIF(provider_id,''),'-') AS provider_name,
        MAX(provider_type) AS provider_type,MAX(provider_builtin_id) AS provider_builtin_id,
        MAX(provider_base_url) AS provider_base_url,
        ${common} FROM usage_activity_daily_providers_v2 ${filter}
        GROUP BY provider_id ${order}`
        )
        .all(...values, limit, skip)
    }
  throw new Error('INVALID_BUSINESS_USAGE_OPERATION')
}

function usageDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error('INVALID_BUSINESS_USAGE_DAY')
  return value
}

function usageEventValue(column, value) {
  if (column === 'input_tokens' || column === 'output_tokens') value ??= 0
  if (value === undefined || value === null) return null
  if (USAGE_INTEGER_COLUMNS.has(column)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`INVALID_BUSINESS_USAGE_${column.toUpperCase()}`)
    return value
  }
  if (USAGE_REAL_COLUMNS.has(column)) {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(`INVALID_BUSINESS_USAGE_${column.toUpperCase()}`)
    return value
  }
  if (typeof value !== 'string' || value.length > 20_000)
    throw new Error(`INVALID_BUSINESS_USAGE_${column.toUpperCase()}`)
  return value
}

function usageOwner(input, workspaceId) {
  let owner = null
  if (input.session_id) {
    const row = db.prepare('SELECT workspace_id FROM sessions WHERE id=?').get(input.session_id)
    if (!row) throw new Error('BUSINESS_USAGE_SESSION_NOT_FOUND')
    owner = row.workspace_id
  }
  if (input.project_id) {
    const row = db.prepare('SELECT workspace_id FROM projects WHERE id=?').get(input.project_id)
    if (!row) throw new Error('BUSINESS_USAGE_PROJECT_NOT_FOUND')
    if (owner !== null && owner !== row.workspace_id)
      throw new Error('BUSINESS_USAGE_SOURCE_WORKSPACE_MISMATCH')
    owner = row.workspace_id
  }
  if (owner !== null && owner !== workspaceId)
    throw new Error('BUSINESS_USAGE_SOURCE_WORKSPACE_MISMATCH')
}

function addUsageEvent(input) {
  const workspaceId = text(input.workspace_id, 'WORKSPACE')
  const id = text(input.id, 'USAGE_EVENT')
  const createdAt = timestamp(input.created_at, 'CREATED_AT')
  const sourceKind = text(input.source_kind, 'USAGE_SOURCE_KIND')
  usageOwner(input, workspaceId)
  const values = USAGE_EVENT_COLUMNS.map((column) =>
    usageEventValue(
      column,
      column === 'id'
        ? id
        : column === 'created_at'
          ? createdAt
          : column === 'source_kind'
            ? sourceKind
            : column === 'workspace_id'
              ? workspaceId
              : input[column]
    )
  )
  const placeholders = USAGE_EVENT_COLUMNS.map(() => '?').join(',')
  const effectiveInput = `MAX(0,COALESCE(billable_input_tokens,
    input_tokens-COALESCE(cache_read_tokens,0)-COALESCE(cache_creation_tokens,0)))`
  const commonValues = `1,${effectiveInput},output_tokens,COALESCE(cache_creation_tokens,0),
    COALESCE(cache_read_tokens,0),COALESCE(reasoning_tokens,0),COALESCE(total_cost_usd,0),?`
  const updateCounters = `request_count=request_count+1,
    input_tokens=input_tokens+excluded.input_tokens,
    output_tokens=output_tokens+excluded.output_tokens,
    cache_creation_tokens=cache_creation_tokens+excluded.cache_creation_tokens,
    cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,
    reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens,
    total_cost_usd=total_cost_usd+excluded.total_cost_usd,
    updated_at=excluded.updated_at`
  const updatedAt = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `INSERT INTO usage_events (${USAGE_EVENT_COLUMNS.join(',')}) VALUES (${placeholders})`
    ).run(...values)
    db.prepare(
      `INSERT INTO usage_activity_daily_v2 (
      workspace_id,day,first_at,last_at,request_count,input_tokens,output_tokens,
      cache_creation_tokens,cache_read_tokens,reasoning_tokens,total_cost_usd,updated_at
    ) SELECT workspace_id,strftime('%Y-%m-%d',created_at/1000,'unixepoch','localtime'),
      created_at,created_at,${commonValues} FROM usage_events WHERE id=?
    ON CONFLICT(workspace_id,day) DO UPDATE SET
      first_at=MIN(first_at,excluded.first_at),last_at=MAX(last_at,excluded.last_at),
      ${updateCounters}`
    ).run(updatedAt, id)
    db.prepare(
      `INSERT INTO usage_activity_daily_models_v2 (
      workspace_id,day,provider_id,provider_name,model_id,model_name,
      request_count,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
      reasoning_tokens,total_cost_usd,updated_at
    ) SELECT workspace_id,strftime('%Y-%m-%d',created_at/1000,'unixepoch','localtime'),
      COALESCE(provider_id,''),provider_name,COALESCE(model_id,''),model_name,
      ${commonValues} FROM usage_events WHERE id=?
    ON CONFLICT(workspace_id,day,provider_id,model_id) DO UPDATE SET
      provider_name=COALESCE(excluded.provider_name,provider_name),
      model_name=COALESCE(excluded.model_name,model_name),${updateCounters}`
    ).run(updatedAt, id)
    db.prepare(
      `INSERT INTO usage_activity_daily_providers_v2 (
      workspace_id,day,provider_id,provider_name,provider_type,provider_builtin_id,
      provider_base_url,request_count,input_tokens,output_tokens,cache_creation_tokens,
      cache_read_tokens,reasoning_tokens,total_cost_usd,updated_at
    ) SELECT workspace_id,strftime('%Y-%m-%d',created_at/1000,'unixepoch','localtime'),
      COALESCE(provider_id,''),provider_name,provider_type,provider_builtin_id,
      provider_base_url,${commonValues} FROM usage_events WHERE id=?
    ON CONFLICT(workspace_id,day,provider_id) DO UPDATE SET
      provider_name=COALESCE(excluded.provider_name,provider_name),
      provider_type=COALESCE(excluded.provider_type,provider_type),
      provider_builtin_id=COALESCE(excluded.provider_builtin_id,provider_builtin_id),
      provider_base_url=COALESCE(excluded.provider_base_url,provider_base_url),
      ${updateCounters}`
    ).run(updatedAt, id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { id, created_at: createdAt, workspace_id: workspaceId }
}

function maintainUsage(cutoff) {
  const before = timestamp(cutoff, 'USAGE_CUTOFF')
  const now = Date.now()
  const day = `strftime('%Y-%m-%d',created_at/1000,'unixepoch','localtime')`
  const effectiveInput = `COALESCE(billable_input_tokens,
    MAX(input_tokens-COALESCE(cache_read_tokens,0)-COALESCE(cache_creation_tokens,0),0))`
  const totals = `COUNT(*),COALESCE(SUM(${effectiveInput}),0),
    COALESCE(SUM(output_tokens),0),COALESCE(SUM(cache_creation_tokens),0),
    COALESCE(SUM(cache_read_tokens),0),COALESCE(SUM(reasoning_tokens),0),
    COALESCE(SUM(total_cost_usd),0),?`
  const aggregates = [
    {
      table: 'usage_activity_daily_v2',
      columns: 'workspace_id,day,first_at,last_at',
      dimensions: `workspace_id,${day} AS day,MIN(created_at),MAX(created_at)`,
      group: 'workspace_id,day'
    },
    {
      table: 'usage_activity_daily_models_v2',
      columns: 'workspace_id,day,provider_id,provider_name,model_id,model_name',
      dimensions: `workspace_id,${day} AS day,COALESCE(provider_id,''),MAX(provider_name),
        COALESCE(model_id,''),MAX(model_name)`,
      group: "workspace_id,day,COALESCE(provider_id,''),COALESCE(model_id,'')"
    },
    {
      table: 'usage_activity_daily_providers_v2',
      columns: `workspace_id,day,provider_id,provider_name,provider_type,
        provider_builtin_id,provider_base_url`,
      dimensions: `workspace_id,${day} AS day,COALESCE(provider_id,''),MAX(provider_name),
        MAX(provider_type),MAX(provider_builtin_id),MAX(provider_base_url)`,
      group: "workspace_id,day,COALESCE(provider_id,'')"
    }
  ]
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const aggregate of aggregates) {
      db.prepare(
        `INSERT OR IGNORE INTO ${aggregate.table} (
        ${aggregate.columns},request_count,input_tokens,output_tokens,
        cache_creation_tokens,cache_read_tokens,reasoning_tokens,total_cost_usd,updated_at
      ) SELECT ${aggregate.dimensions},${totals} FROM usage_events
        WHERE created_at<? GROUP BY ${aggregate.group}`
      ).run(now, before)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  let deleted = 0
  while (true) {
    const result = db
      .prepare(
        `DELETE FROM usage_events WHERE rowid IN (
      SELECT rowid FROM usage_events WHERE created_at<? AND EXISTS (
        SELECT 1 FROM usage_activity_daily_v2 AS daily
        WHERE daily.workspace_id=usage_events.workspace_id
          AND daily.day=strftime('%Y-%m-%d',usage_events.created_at/1000,'unixepoch','localtime')
      ) ORDER BY created_at ASC LIMIT 250
    )`
      )
      .run(before)
    deleted += Number(result.changes)
    if (result.changes < 250) break
  }
  return { cutoff: before, deleted }
}

function subAgentSession(sessionId, workspaceId) {
  if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SUB_AGENT_SESSION_NOT_FOUND')
}

function upsertSubAgentHistory(item, workspaceId) {
  const sessionId = text(item.sessionId, 'SESSION')
  subAgentSession(sessionId, workspaceId)
  const result = db
    .prepare(
      `INSERT INTO sub_agent_history (
    id,session_id,sub_agent_id,tool_use_id,name,status,started_at,
    completed_at,updated_at,sort_order,snapshot_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,tool_use_id) DO UPDATE SET
    sub_agent_id=excluded.sub_agent_id,name=excluded.name,status=excluded.status,
    started_at=excluded.started_at,completed_at=excluded.completed_at,
    updated_at=excluded.updated_at,sort_order=excluded.sort_order,
    snapshot_json=excluded.snapshot_json`
    )
    .run(
      text(item.id, 'SUB_AGENT_HISTORY'),
      sessionId,
      text(item.subAgentId, 'SUB_AGENT'),
      text(item.toolUseId, 'TOOL_USE'),
      text(item.name, 'SUB_AGENT_NAME'),
      text(item.status, 'SUB_AGENT_STATUS'),
      timestamp(item.startedAt, 'STARTED_AT'),
      nullableInteger(item.completedAt, 'COMPLETED_AT'),
      timestamp(item.updatedAt, 'UPDATED_AT'),
      timestamp(item.sortOrder ?? 0, 'SORT_ORDER'),
      cronJson(item.snapshotJson, 'SUB_AGENT_SNAPSHOT')
    )
  return Number(result.changes)
}

function subAgentHistoryRows(sessionId, workspaceId, limit, offsetValue, includeSnapshot) {
  subAgentSession(sessionId, workspaceId)
  const columns = `id,session_id AS sessionId,sub_agent_id AS subAgentId,
    tool_use_id AS toolUseId,name,status,started_at AS startedAt,
    completed_at AS completedAt,updated_at AS updatedAt,sort_order AS sortOrder,
    ${includeSnapshot ? 'snapshot_json' : 'NULL'} AS snapshotJson`
  return db
    .prepare(
      `SELECT ${columns} FROM sub_agent_history WHERE session_id=?
    ORDER BY started_at DESC,sort_order DESC LIMIT ? OFFSET ?`
    )
    .all(sessionId, limit, offsetValue)
}

function nullableInteger(value, field) {
  if (value === undefined || value === null) return null
  return timestamp(value, field)
}

function nullableText(value, field) {
  if (value === undefined || value === null) return null
  return text(value, field)
}

function normalizedOptionalText(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`INVALID_BUSINESS_${field}`)
  return value.trim() ? text(value, field) : null
}

function memoryContent(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000_000)
    throw new Error(`INVALID_BUSINESS_${field}`)
  return value
}

function optionalMemoryContent(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 20_000_000)
    throw new Error(`INVALID_BUSINESS_${field}`)
  return value
}

function memoryOwnerPath(value, sshConnectionId) {
  if (!value) return ''
  const trimmed = value.trim()
  return sshConnectionId
    ? trimmed.replaceAll('\\', '/')
    : resolve(trimmed).replaceAll('\\', '/').toLowerCase()
}

function memoryRootInWorkspace(id, workspaceId) {
  return (
    db.prepare('SELECT * FROM memory_roots WHERE id=? AND workspace_id=?').get(id, workspaceId) ??
    null
  )
}

function assertMemorySourceSession(sourceSessionId, workspaceId) {
  if (!sourceSessionId || sourceSessionId.startsWith('rollup:')) return
  if (!session(sourceSessionId, workspaceId)) throw new Error('BUSINESS_MEMORY_SESSION_NOT_FOUND')
}

function cronPrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000_000)
    throw new Error('INVALID_BUSINESS_CRON_PROMPT')
  return value
}

function nullableCronText(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 20_000_000)
    throw new Error(`INVALID_BUSINESS_${field}`)
  return value
}

function cronJson(value, field) {
  if (typeof value !== 'string' || value.length > 20_000_000)
    throw new Error(`INVALID_BUSINESS_${field}`)
  try {
    JSON.parse(value)
  } catch {
    throw new Error(`INVALID_BUSINESS_${field}`)
  }
  return value
}

function cronSchedule(input) {
  const kind = text(input.scheduleKind, 'CRON_SCHEDULE_KIND')
  if (kind === 'at') {
    return [kind, timestamp(input.scheduleAt, 'CRON_SCHEDULE_AT'), null, null]
  }
  if (kind === 'every') {
    const every = timestamp(input.scheduleEvery, 'CRON_SCHEDULE_EVERY')
    if (every < 1_000) throw new Error('INVALID_BUSINESS_CRON_SCHEDULE_EVERY')
    return [kind, null, every, null]
  }
  if (kind === 'cron') {
    return [kind, null, null, text(input.scheduleExpr, 'CRON_SCHEDULE_EXPR')]
  }
  throw new Error('INVALID_BUSINESS_CRON_SCHEDULE_KIND')
}

function cronModelSource(value, workspaceId) {
  if (value == null) return null
  if (typeof value !== 'string' || value.length > 4096)
    throw new Error('INVALID_BUSINESS_CRON_MODEL_SOURCE')
  let source
  try {
    source = JSON.parse(value)
  } catch {
    throw new Error('INVALID_BUSINESS_CRON_MODEL_SOURCE')
  }
  const keys =
    source && typeof source === 'object' && !Array.isArray(source)
      ? Object.keys(source).sort().join(',')
      : ''
  const identifier = (item) => typeof item === 'string' && item.trim() && item.length <= 1024
  const local =
    source?.kind === 'local' &&
    keys === 'kind,modelId,providerId' &&
    identifier(source.modelId) &&
    identifier(source.providerId)
  const managed =
    (source?.kind === 'ola-personal' || source?.kind === 'ola-team') &&
    keys === 'kind,resourceId,workspaceId' &&
    source.workspaceId === workspaceId &&
    identifier(source.resourceId)
  if (!local && !managed) throw new Error('INVALID_BUSINESS_CRON_MODEL_SOURCE')
  return value
}

function sessionProjectModelSource(value, workspaceId) {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error('INVALID_BUSINESS_MODEL_SOURCE')
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > 4096) throw new Error('INVALID_BUSINESS_MODEL_SOURCE')
  let source
  try {
    source = JSON.parse(trimmed)
  } catch {
    throw new Error('INVALID_BUSINESS_MODEL_SOURCE')
  }
  const keys =
    source && typeof source === 'object' && !Array.isArray(source)
      ? Object.keys(source).sort().join(',')
      : ''
  const identifier = (item) =>
    typeof item === 'string' &&
    item.trim() &&
    item.length <= 1024 &&
    [...item].every((character) => {
      const code = character.codePointAt(0)
      return code > 0x9f || (code > 0x1f && code < 0x7f)
    })
  const local =
    source?.kind === 'local' &&
    keys === 'kind,modelId,providerId' &&
    identifier(source.modelId) &&
    identifier(source.providerId)
  const managed =
    (source?.kind === 'ola-personal' || source?.kind === 'ola-team') &&
    keys === 'kind,resourceId,workspaceId' &&
    source.workspaceId === workspaceId &&
    identifier(source.resourceId)
  if (!local && !managed) throw new Error('INVALID_BUSINESS_MODEL_SOURCE')
  return trimmed
}

function taskProfile(value) {
  if (value === null) return null
  if (value !== 'work' && value !== 'code') throw new Error('INVALID_BUSINESS_TASK_PROFILE')
  return value
}

function scenarioPolicy(value) {
  if (value == null) return null
  if (value !== 'project-read-only' && value !== 'ssh-read-only' && value !== 'materials-no-tools')
    throw new Error('INVALID_BUSINESS_SCENARIO_POLICY')
  return value
}

function sessionProviderId(value, workspaceId) {
  const providerId = normalizedOptionalText(value, 'PROVIDER')
  if (
    providerId?.startsWith('ola-managed:') &&
    providerId.slice('ola-managed:'.length) !== workspaceId
  )
    throw new Error('INVALID_BUSINESS_SESSION_PROVIDER')
  return providerId
}

function cronSourceProvider(value, workspaceId) {
  const providerId = nullableText(value, 'CRON_PROVIDER')
  if (
    providerId?.startsWith('ola-managed:') &&
    providerId.slice('ola-managed:'.length) !== workspaceId
  )
    throw new Error('INVALID_BUSINESS_CRON_SOURCE_PROVIDER')
  return providerId
}

function channelModelSource(value, workspaceId) {
  try {
    return cronModelSource(value, workspaceId)
  } catch {
    throw new Error('INVALID_BUSINESS_CHANNEL_MODEL_SOURCE')
  }
}

function cronScope(sessionId, sourceProjectId, workspaceId) {
  if (sessionId != null && !session(sessionId, workspaceId))
    throw new Error('BUSINESS_CRON_SESSION_NOT_FOUND')
  if (
    sourceProjectId != null &&
    !db
      .prepare('SELECT id FROM projects WHERE id=? AND workspace_id=?')
      .get(sourceProjectId, workspaceId)
  )
    throw new Error('BUSINESS_CRON_PROJECT_NOT_FOUND')
}

function cronSnapshotScope(sessionId, sourceProjectId, workspaceId) {
  if (sessionId != null) {
    const owner = db.prepare('SELECT workspace_id FROM sessions WHERE id=?').get(sessionId)
    if (owner && owner.workspace_id !== workspaceId)
      throw new Error('BUSINESS_CRON_SESSION_WORKSPACE_MISMATCH')
  }
  if (sourceProjectId != null) {
    const owner = db.prepare('SELECT workspace_id FROM projects WHERE id=?').get(sourceProjectId)
    if (owner && owner.workspace_id !== workspaceId)
      throw new Error('BUSINESS_CRON_PROJECT_WORKSPACE_MISMATCH')
  }
}

function cronDeliveryMode(value) {
  const mode = value ?? 'desktop'
  if (mode !== 'desktop' && mode !== 'session' && mode !== 'none')
    throw new Error('INVALID_BUSINESS_CRON_DELIVERY_MODE')
  return mode
}

function cronRun(runId, workspaceId) {
  return db
    .prepare(
      `SELECT r.id FROM cron_runs r JOIN cron_jobs j ON j.id=r.job_id
      WHERE r.id=? AND j.workspace_id=?`
    )
    .get(runId, workspaceId)
}

function bool(value, field) {
  if (typeof value !== 'boolean') throw new Error(`INVALID_BUSINESS_${field}`)
  return value ? 1 : 0
}

function list(value, field) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new Error(`INVALID_BUSINESS_${field}`)
  return JSON.stringify(value)
}

function session(id, workspaceId) {
  return (
    db
      .prepare(
        `SELECT id, title, icon, mode, created_at, updated_at, project_id, working_folder,
                ssh_connection_id, plan_id, pinned, plugin_id, external_chat_id, provider_id,
                model_id, model_selection_mode, model_source, task_profile, task_profile_locked,
                scenario_policy,
                workspace_id, message_count
           FROM sessions WHERE id=? AND workspace_id=?`
      )
      .get(id, workspaceId) ?? null
  )
}

function messageValue(value, field) {
  if (typeof value !== 'string' || value.length > 20_000_000)
    throw new Error(`INVALID_BUSINESS_${field}`)
  return value
}

function optionalMessageValue(value, field) {
  if (value === undefined || value === null) return null
  return messageValue(value, field)
}

function messageInput(input, workspaceId, sessionIdOverride) {
  const sessionId = sessionIdOverride ?? text(input.sessionId, 'SESSION')
  if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
  return {
    id: text(input.id, 'MESSAGE'),
    sessionId,
    role: text(input.role, 'ROLE'),
    content: messageValue(input.content ?? '', 'MESSAGE_CONTENT'),
    meta: optionalMessageValue(input.meta, 'MESSAGE_META'),
    createdAt: timestamp(input.createdAt, 'CREATED_AT'),
    usage: optionalMessageValue(input.usage, 'MESSAGE_USAGE'),
    sortOrder: timestamp(input.sortOrder ?? 0, 'SORT_ORDER')
  }
}

function assertMessageIdOwner(id, sessionId) {
  const existing = db.prepare('SELECT session_id FROM messages WHERE id=?').get(id)
  if (existing && existing.session_id !== sessionId)
    throw new Error('BUSINESS_MESSAGE_SESSION_MISMATCH')
}

function insertMessage(input, mode = 'INSERT OR IGNORE') {
  assertMessageIdOwner(input.id, input.sessionId)
  return db
    .prepare(
      `${mode} INTO messages(id,session_id,role,content,meta,created_at,usage,sort_order)
       VALUES(?,?,?,?,?,?,?,?)`
    )
    .run(
      input.id,
      input.sessionId,
      input.role,
      input.content,
      input.meta,
      input.createdAt,
      input.usage,
      input.sortOrder
    ).changes
}

function setSessionMessageCount(sessionId, workspaceId) {
  const count = Number(
    db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(sessionId)?.count ??
      0
  )
  db.prepare('UPDATE sessions SET message_count=? WHERE id=? AND workspace_id=?').run(
    count,
    sessionId,
    workspaceId
  )
  return count
}

function normalizeSessionMessageSortOrders(sessionId) {
  const rows = db
    .prepare(
      `SELECT id,role,created_at,sort_order FROM messages
       WHERE session_id=? ORDER BY sort_order ASC,created_at ASC`
    )
    .all(sessionId)
  const seen = new Set()
  const anomaly = rows.some(
    (row, index) =>
      row.sort_order !== index || seen.has(row.sort_order) || !seen.add(row.sort_order)
  )
  if (!anomaly) return 0
  const roleOrder = { user: 0, assistant: 1, system: 2 }
  rows.sort(
    (left, right) =>
      left.created_at - right.created_at ||
      (roleOrder[left.role] ?? 10) - (roleOrder[right.role] ?? 10) ||
      left.sort_order - right.sort_order
  )
  const update = db.prepare('UPDATE messages SET sort_order=? WHERE id=?')
  let changed = 0
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].sort_order === index) continue
    changed += Number(update.run(index, rows[index].id).changes)
  }
  return changed
}

function isCompactArtifact(input) {
  return (
    input.meta?.includes('compactBoundary') ||
    input.meta?.includes('compactSummary') ||
    input.content.includes('[Context Memory Compressed Summary]')
  )
}

function compactMessageContent(content) {
  try {
    const blocks = JSON.parse(content)
    if (!Array.isArray(blocks)) return null
    let changed = false
    const compacted = blocks.map((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return block
      const toolResult =
        block.type === 'tool_result' &&
        Object.hasOwn(block, 'content') &&
        (typeof block.content === 'string'
          ? block.content.length
          : JSON.stringify(block.content).length) > 200
      const thinking = block.type === 'thinking'
      if (!toolResult && !thinking) return block
      changed = true
      const result = Object.fromEntries(
        Object.entries(block).filter(([key]) => key !== (toolResult ? 'content' : 'thinking'))
      )
      if (toolResult) result.content = '[Context compressed — stale tool result cleared]'
      if (thinking) result.thinking = '[Thinking cleared during compression]'
      return result
    })
    return changed ? JSON.stringify(compacted).replaceAll('—', '\\u2014') : null
  } catch {
    return null
  }
}

function usageNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function channelSession(id, workspaceId) {
  const row = session(id, workspaceId)
  return row?.plugin_id ? row : null
}

function channelTitle(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function allocateProjectDirectory(baseDirectory, preferredName) {
  const base = text(baseDirectory, 'PROJECT_BASE_DIRECTORY')
  if (!isAbsolute(base)) throw new Error('INVALID_BUSINESS_PROJECT_BASE_DIRECTORY')
  mkdirSync(base, { recursive: true })
  const sanitized = preferredName
    .replace(/[<>:"/\\|?*]/g, ' ')
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
  const name = sanitized || 'New Project'
  for (let suffix = 0; ; suffix++) {
    const candidateName = suffix === 0 ? name : `${name} (${suffix})`
    const candidatePath = join(base, candidateName)
    if (existsSync(candidatePath)) continue
    mkdirSync(candidatePath)
    return { name: candidateName, workingFolder: candidatePath }
  }
}

function channelChatId(value) {
  if (typeof value !== 'string' || !value) throw new Error('INVALID_BUSINESS_CHANNEL_CHAT')
  return value
}

function shouldReplaceChannelTitle(current, next) {
  if (!next || current === next) return false
  return (
    !current ||
    current === 'New Conversation' ||
    current === 'New Chat' ||
    /^oc_|^Plugin /i.test(current)
  )
}

function agentChangeSet(runId, workspaceId) {
  const set = db
    .prepare(
      `SELECT run_id AS runId,session_id AS sessionId,
      assistant_message_id AS assistantMessageId,status,
      created_at AS createdAt,updated_at AS updatedAt
      FROM agent_change_sets WHERE run_id=? AND workspace_id=?`
    )
    .get(runId, workspaceId)
  if (!set) return null
  const changes = db
    .prepare(
      `SELECT id,run_id AS runId,session_id AS sessionId,
      tool_use_id AS toolUseId,tool_name AS toolName,file_path AS filePath,
      transport,connection_id AS connectionId,op,status,
      before_json AS beforeJson,after_json AS afterJson,
      created_at AS createdAt,reverted_at AS revertedAt
      FROM agent_file_changes WHERE run_id=?
      ORDER BY sort_order ASC,created_at ASC`
    )
    .all(runId)
    .map(({ beforeJson, afterJson, ...change }) => {
      for (const field of ['sessionId', 'toolUseId', 'toolName', 'connectionId', 'revertedAt'])
        if (change[field] === null) delete change[field]
      return { ...change, before: JSON.parse(beforeJson), after: JSON.parse(afterJson) }
    })
  if (set.sessionId === null) delete set.sessionId
  return { ...set, changes }
}

function agentChangeOwner(sessionId, workspaceId) {
  if (!sessionId) {
    if (workspaceId !== 'local-personal') throw new Error('BUSINESS_AGENT_CHANGE_SESSION_REQUIRED')
    return
  }
  const owner = db.prepare('SELECT workspace_id FROM sessions WHERE id=?').get(sessionId)
  if (!owner) throw new Error('BUSINESS_AGENT_CHANGE_SESSION_NOT_FOUND')
  if (owner.workspace_id !== workspaceId)
    throw new Error('BUSINESS_AGENT_CHANGE_WORKSPACE_MISMATCH')
}

function agentSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_BUSINESS_AGENT_SNAPSHOT')
  if (typeof value.exists !== 'boolean' || !Number.isSafeInteger(value.size) || value.size < 0)
    throw new Error('INVALID_BUSINESS_AGENT_SNAPSHOT')
  if (value.hash !== null && typeof value.hash !== 'string')
    throw new Error('INVALID_BUSINESS_AGENT_SNAPSHOT')
  return JSON.stringify(value)
}

function recomputeAgentChange(runId, workspaceId, now) {
  const set = db
    .prepare('SELECT run_id FROM agent_change_sets WHERE run_id=? AND workspace_id=?')
    .get(runId, workspaceId)
  if (!set) return false
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS openCount
      FROM agent_file_changes WHERE run_id=?`
    )
    .get(runId)
  const status = counts.total > 0 && !counts.openCount ? 'reverted' : 'open'
  db.prepare(
    'UPDATE agent_change_sets SET status=?,updated_at=? WHERE run_id=? AND workspace_id=?'
  ).run(status, now, runId, workspaceId)
  return true
}

function task(id, workspaceId) {
  return (
    db
      .prepare(
        `SELECT t.id,t.session_id FROM tasks t JOIN sessions s ON s.id=t.session_id
          WHERE t.id=? AND s.workspace_id=?`
      )
      .get(id, workspaceId) ?? null
  )
}

function plan(id, workspaceId, sessionId) {
  const conditions = ['p.id=?', 's.workspace_id=?']
  const values = [id, workspaceId]
  if (sessionId) {
    conditions.push('p.session_id=?')
    values.push(sessionId)
  }
  return (
    db
      .prepare(
        `SELECT p.id, p.session_id, p.title, p.status, p.file_path, p.content, p.spec_json,
                p.created_at, p.updated_at, s.workspace_id
           FROM plans p JOIN sessions s ON s.id=p.session_id WHERE ${conditions.join(' AND ')}`
      )
      .get(...values) ?? null
  )
}

function assertExistingSessionPlanOwner(planId, sessionId) {
  if (!planId) return
  const owner = db.prepare('SELECT session_id FROM plans WHERE id=?').get(planId)
  if (owner && owner.session_id !== sessionId) throw new Error('BUSINESS_SESSION_PLAN_MISMATCH')
}

function goal(sessionId, workspaceId) {
  return (
    db
      .prepare(
        `SELECT g.session_id, g.goal_id, g.objective, g.status, g.token_budget, g.tokens_used,
                g.time_used_seconds, g.created_at, g.updated_at
           FROM session_goals g JOIN sessions s ON s.id=g.session_id
          WHERE g.session_id=? AND s.workspace_id=?`
      )
      .get(sessionId, workspaceId) ?? null
  )
}

function updateFields(input, fields, updatedAt) {
  const changes = []
  const values = []
  for (const [column, key, normalize] of fields) {
    if (input[key] === undefined) continue
    changes.push(`${column}=?`)
    values.push(normalize(input[key]))
  }
  if (!changes.length) throw new Error('BUSINESS_UPDATE_EMPTY')
  if (updatedAt !== undefined) {
    changes.push('updated_at=?')
    values.push(timestamp(updatedAt, 'UPDATED_AT'))
  }
  return { changes, values }
}

function redactDesktopFlow(flow) {
  if (!flow || typeof flow !== 'object' || !Array.isArray(flow.steps))
    throw new Error('INVALID_BUSINESS_DESKTOP_FLOW')
  let removedCapturedText = false
  let hasTypingSteps = false
  const steps = flow.steps.map((step) => {
    if (step?.type === 'type') hasTypingSteps = true
    if (step?.type !== 'type' || typeof step.text !== 'string' || !step.text) return step
    removedCapturedText = true
    const safeStep = { ...step }
    delete safeStep.text
    return {
      ...safeStep,
      expectedChange:
        step.expectedChange ?? 'Captured input removed for safety. Recreate this step.'
    }
  })
  return removedCapturedText || hasTypingSteps
    ? { ...flow, steps, requiresReview: true }
    : { ...flow, steps }
}

function dispatch(method, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('INVALID_BUSINESS_REQUEST')
  if (method === 'desktop-flows-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return db
      .prepare(
        'SELECT flow_json FROM desktop_flows WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 100'
      )
      .all(workspaceId)
      .map((row) => redactDesktopFlow(JSON.parse(row.flow_json)))
      .filter((flow) => (flow.workspaceId ?? 'local-personal') === workspaceId)
  }
  if (method === 'desktop-flow-save') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const flow = args.flow
    if (!flow || typeof flow !== 'object' || Array.isArray(flow))
      throw new Error('INVALID_BUSINESS_DESKTOP_FLOW')
    const id = text(flow.id, 'DESKTOP_FLOW_ID')
    const name = text(flow.name, 'DESKTOP_FLOW_NAME')
    if (
      id.length > 128 ||
      name.length > 160 ||
      !Array.isArray(flow.steps) ||
      flow.steps.length > 1000
    )
      throw new Error('INVALID_BUSINESS_DESKTOP_FLOW')
    if ((flow.workspaceId ?? 'local-personal') !== workspaceId)
      throw new Error('BUSINESS_DESKTOP_FLOW_WORKSPACE_MISMATCH')
    const normalized = redactDesktopFlow({ ...flow, workspaceId })
    const flowJson = JSON.stringify(normalized)
    if (Buffer.byteLength(flowJson, 'utf8') > 5 * 1024 * 1024)
      throw new Error('BUSINESS_DESKTOP_FLOW_TOO_LARGE')
    const createdAt = timestamp(flow.createdAt, 'DESKTOP_FLOW_CREATED_AT')
    const updatedAt = timestamp(flow.updatedAt, 'DESKTOP_FLOW_UPDATED_AT')
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = db.prepare('SELECT workspace_id FROM desktop_flows WHERE id=?').get(id)
      if (existing && existing.workspace_id !== workspaceId)
        throw new Error('BUSINESS_DESKTOP_FLOW_WORKSPACE_MISMATCH')
      db.prepare(
        `INSERT INTO desktop_flows(id,name,flow_json,created_at,updated_at,workspace_id)
         VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,flow_json=excluded.flow_json,updated_at=excluded.updated_at`
      ).run(id, name, flowJson, createdAt, updatedAt, workspaceId)
      db.prepare('DELETE FROM desktop_flow_steps WHERE flow_id=?').run(id)
      const insertStep = db.prepare(
        `INSERT OR REPLACE INTO desktop_flow_steps(flow_id,step_id,sort_order,step_json,updated_at)
         VALUES(?,?,?,?,?)`
      )
      let sortOrder = 0
      for (const step of flow.steps) {
        if (!step || typeof step !== 'object' || Array.isArray(step)) continue
        if (typeof step.id !== 'string' || !step.id || step.id.length > 128) continue
        insertStep.run(id, step.id, sortOrder++, JSON.stringify(step), updatedAt)
      }
      db.exec('COMMIT')
      return true
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'desktop-flow-delete') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'DESKTOP_FLOW_ID')
    db.exec('BEGIN IMMEDIATE')
    try {
      const deleted =
        db.prepare('DELETE FROM desktop_flows WHERE id=? AND workspace_id=?').run(id, workspaceId)
          .changes > 0
      if (deleted) {
        db.prepare('DELETE FROM desktop_flow_steps WHERE flow_id=?').run(id)
        db.prepare('DELETE FROM desktop_flow_runs WHERE flow_id=?').run(id)
      }
      db.exec('COMMIT')
      return deleted
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'desktop-flow-run-start') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'DESKTOP_FLOW_RUN_ID')
    const flowId = text(args.flowId, 'DESKTOP_FLOW_ID')
    const startedAt = timestamp(args.startedAt, 'DESKTOP_FLOW_RUN_STARTED_AT')
    const result = db
      .prepare(
        `INSERT INTO desktop_flow_runs(id,flow_id,state,started_at)
         SELECT ?,id,'running',? FROM desktop_flows WHERE id=? AND workspace_id=?`
      )
      .run(id, startedAt, flowId, workspaceId)
    if (result.changes === 0) throw new Error('BUSINESS_DESKTOP_FLOW_WORKSPACE_MISMATCH')
    return true
  }
  if (method === 'desktop-flow-run-finish') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'DESKTOP_FLOW_RUN_ID')
    const state = text(args.state, 'DESKTOP_FLOW_RUN_STATE')
    if (!['succeeded', 'failed', 'cancelled'].includes(state))
      throw new Error('INVALID_BUSINESS_DESKTOP_FLOW_RUN_STATE')
    const finishedAt = timestamp(args.finishedAt, 'DESKTOP_FLOW_RUN_FINISHED_AT')
    const errorMessage =
      args.errorMessage == null ? null : text(args.errorMessage, 'DESKTOP_FLOW_RUN_ERROR')
    return (
      db
        .prepare(
          `UPDATE desktop_flow_runs SET state=?,error_message=?,finished_at=?
           WHERE id=? AND state='running' AND flow_id IN
             (SELECT id FROM desktop_flows WHERE workspace_id=?)`
        )
        .run(state, errorMessage, finishedAt, id, workspaceId).changes > 0
    )
  }
  if (method === 'desktop-flow-runs-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const limit = args.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
      throw new Error('INVALID_BUSINESS_DESKTOP_FLOW_RUN_LIMIT')
    return db
      .prepare(
        `SELECT r.id,r.flow_id AS flowId,r.state,r.error_message AS errorMessage,
          r.started_at AS startedAt,r.finished_at AS finishedAt
         FROM desktop_flow_runs r JOIN desktop_flows f ON f.id=r.flow_id
         WHERE f.workspace_id=? ORDER BY r.started_at DESC LIMIT ?`
      )
      .all(workspaceId, limit)
  }
  if (method === 'wiki-get') {
    const projectRoot = wikiProjectRoot(args.projectRoot)
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const row = db
      .prepare(
        `SELECT document_json FROM wiki_documents
         WHERE project_root=? AND (workspace_id=? OR workspace_id IS NULL)
         LIMIT 1`
      )
      .get(wikiStorageKey(projectRoot, workspaceId), workspaceId)
    if (!row) return null
    const document = JSON.parse(row.document_json)
    if (!document || document.projectRoot !== projectRoot)
      throw new Error('BUSINESS_WIKI_DOCUMENT_INVALID')
    return document
  }
  if (method === 'legacy-wiki-counts') {
    const workspaceId = args.workspaceId == null ? null : text(args.workspaceId, 'WORKSPACE')
    const hasTable = (table) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(table) !==
      undefined
    if (
      !hasTable('ola_native_wiki_documents_v1') ||
      !hasTable('ola_native_wiki_generation_runs_v1')
    )
      return { documents: 0, generationRuns: 0 }
    const workspaceClause = workspaceId ? ' AND COALESCE(p.workspace_id, ?) = ?' : ''
    const workspaceParams = workspaceId ? [workspaceId, workspaceId] : []
    const documents = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM ola_native_wiki_documents_v1 d
           LEFT JOIN projects p ON p.id=d.project_id
           WHERE 1=1${workspaceClause}`
        )
        .get(...workspaceParams).count ?? 0
    )
    const generationRuns = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM ola_native_wiki_generation_runs_v1 r
           LEFT JOIN projects p ON p.id=r.project_id
           WHERE 1=1${workspaceClause}`
        )
        .get(...workspaceParams).count ?? 0
    )
    return { documents, generationRuns }
  }
  if (method === 'wiki-save') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const document = args.document
    if (!document || typeof document !== 'object' || Array.isArray(document))
      throw new Error('INVALID_BUSINESS_WIKI_DOCUMENT')
    const projectRoot = wikiProjectRoot(document.projectRoot)
    if (!Array.isArray(document.nodes)) throw new Error('INVALID_BUSINESS_WIKI_NODES')
    const documentJson = JSON.stringify(document)
    if (Buffer.byteLength(documentJson, 'utf8') > 10 * 1024 * 1024)
      throw new Error('BUSINESS_WIKI_DOCUMENT_TOO_LARGE')
    const generatedAt = timestamp(document.generatedAt, 'WIKI_GENERATED_AT')
    const updatedAt = timestamp(args.updatedAt, 'WIKI_UPDATED_AT')
    const storageKey = wikiStorageKey(projectRoot, workspaceId)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `INSERT INTO wiki_documents(project_root,document_json,generated_at,updated_at,workspace_id)
         VALUES(?,?,?,?,?) ON CONFLICT(project_root) DO UPDATE SET
         document_json=excluded.document_json,generated_at=excluded.generated_at,
         updated_at=excluded.updated_at,workspace_id=excluded.workspace_id`
      ).run(storageKey, documentJson, generatedAt, updatedAt, workspaceId)
      db.prepare('DELETE FROM wiki_nodes WHERE project_root=?').run(storageKey)
      db.prepare('DELETE FROM wiki_file_snapshots WHERE project_root=?').run(storageKey)
      const insertNode = db.prepare(
        `INSERT OR REPLACE INTO wiki_nodes(project_root,node_path,node_json,updated_at,workspace_id)
         VALUES(?,?,?,?,?)`
      )
      const insertFile = db.prepare(
        `INSERT OR REPLACE INTO wiki_file_snapshots
         (project_root,file_path,content_hash,size_bytes,modified_at,updated_at,workspace_id)
         VALUES(?,?,?,?,?,?,?)`
      )
      for (const node of document.nodes) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) continue
        if (typeof node.path !== 'string' || !node.path || node.path.length > 1024) continue
        insertNode.run(storageKey, node.path, JSON.stringify(node), updatedAt, workspaceId)
        if (node.kind === 'file')
          insertFile.run(
            storageKey,
            node.path,
            typeof node.hash === 'string' ? node.hash : null,
            Number.isSafeInteger(node.size) ? node.size : 0,
            Number.isSafeInteger(node.modifiedAt) ? node.modifiedAt : 0,
            updatedAt,
            workspaceId
          )
      }
      db.prepare(
        `INSERT INTO wiki_generation_runs(id,project_root,state,started_at,finished_at,workspace_id)
         VALUES(?,?,'succeeded',?,?,?)`
      ).run(randomUUID(), storageKey, updatedAt, updatedAt, workspaceId)
      db.exec('COMMIT')
      return true
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'wiki-delete') {
    const projectRoot = wikiProjectRoot(args.projectRoot)
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const storageKey = wikiStorageKey(projectRoot, workspaceId)
    db.exec('BEGIN IMMEDIATE')
    try {
      const deleted =
        db
          .prepare(
            'DELETE FROM wiki_documents WHERE project_root=? AND (workspace_id=? OR workspace_id IS NULL)'
          )
          .run(storageKey, workspaceId).changes > 0
      db.prepare('DELETE FROM wiki_nodes WHERE project_root=?').run(storageKey)
      db.prepare('DELETE FROM wiki_file_snapshots WHERE project_root=?').run(storageKey)
      db.prepare('DELETE FROM wiki_generation_runs WHERE project_root=?').run(storageKey)
      db.exec('COMMIT')
      return deleted
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'agent-change-get') {
    return agentChangeSet(text(args.runId, 'AGENT_RUN'), text(args.workspaceId, 'WORKSPACE'))
  }
  if (method === 'agent-changes-list-session') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    agentChangeOwner(sessionId, workspaceId)
    return db
      .prepare(
        `SELECT DISTINCT s.run_id FROM agent_change_sets s
      LEFT JOIN agent_file_changes c ON c.run_id=s.run_id
      WHERE s.workspace_id=? AND (s.session_id=? OR c.session_id=?)
      ORDER BY s.created_at ASC,s.run_id ASC`
      )
      .all(workspaceId, sessionId, sessionId)
      .map(({ run_id }) => agentChangeSet(run_id, workspaceId))
  }
  if (method === 'agent-change-append-file') {
    const runId = text(args.runId, 'AGENT_RUN')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = nullableText(args.sessionId, 'SESSION')
    const change = args.change
    if (!change || typeof change !== 'object' || Array.isArray(change))
      throw new Error('INVALID_BUSINESS_AGENT_CHANGE')
    const changeSessionId = nullableText(change.sessionId, 'SESSION')
    if (sessionId && changeSessionId && sessionId !== changeSessionId)
      throw new Error('BUSINESS_AGENT_CHANGE_SESSION_MISMATCH')
    const effectiveSessionId = sessionId ?? changeSessionId
    agentChangeOwner(effectiveSessionId, workspaceId)
    const existing = db
      .prepare('SELECT workspace_id FROM agent_change_sets WHERE run_id=?')
      .get(runId)
    if (existing && existing.workspace_id !== workspaceId)
      throw new Error('BUSINESS_AGENT_CHANGE_WORKSPACE_MISMATCH')
    const id = text(change.id, 'AGENT_CHANGE')
    if (text(change.runId, 'AGENT_RUN') !== runId)
      throw new Error('BUSINESS_AGENT_CHANGE_RUN_MISMATCH')
    const now = timestamp(args.now, 'UPDATED_AT')
    const createdAt = timestamp(change.createdAt, 'CREATED_AT')
    const beforeJson = agentSnapshot(change.before)
    const afterJson = agentSnapshot(change.after)
    const transport = text(change.transport, 'AGENT_TRANSPORT')
    const op = text(change.op, 'AGENT_OP')
    const status = text(change.status, 'AGENT_STATUS')
    if (
      !['local', 'ssh'].includes(transport) ||
      !['create', 'modify'].includes(op) ||
      !['open', 'reverted'].includes(status)
    )
      throw new Error('INVALID_BUSINESS_AGENT_CHANGE')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `INSERT INTO agent_change_sets
        (run_id,session_id,workspace_id,assistant_message_id,status,created_at,updated_at)
        VALUES (?,?,?,?, 'open',?,?)
        ON CONFLICT(run_id) DO UPDATE SET
          session_id=COALESCE(agent_change_sets.session_id,excluded.session_id),
          assistant_message_id=excluded.assistant_message_id,status='open',
          updated_at=excluded.updated_at`
      ).run(
        runId,
        effectiveSessionId,
        workspaceId,
        text(args.assistantMessageId, 'ASSISTANT_MESSAGE'),
        now,
        now
      )
      const sortOrder = db
        .prepare(
          `SELECT COALESCE(MAX(sort_order),-1)+1 AS next
        FROM agent_file_changes WHERE run_id=?`
        )
        .get(runId).next
      db.prepare(
        `INSERT INTO agent_file_changes
        (id,run_id,session_id,tool_use_id,tool_name,file_path,transport,connection_id,
         op,status,before_json,after_json,created_at,reverted_at,sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        runId,
        effectiveSessionId,
        nullableText(change.toolUseId, 'TOOL_USE'),
        nullableText(change.toolName, 'TOOL_NAME'),
        text(change.filePath, 'AGENT_FILE_PATH'),
        transport,
        nullableText(change.connectionId, 'CONNECTION'),
        op,
        status,
        beforeJson,
        afterJson,
        createdAt,
        change.revertedAt == null ? null : timestamp(change.revertedAt, 'REVERTED_AT'),
        sortOrder
      )
      db.exec('COMMIT')
      return true
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'agent-change-mark-reverted') {
    const runId = text(args.runId, 'AGENT_RUN')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!agentChangeSet(runId, workspaceId)) return false
    const changeId = text(args.changeId, 'AGENT_CHANGE')
    const revertedAt = timestamp(args.revertedAt, 'REVERTED_AT')
    db.exec('BEGIN IMMEDIATE')
    try {
      const changed =
        db
          .prepare(
            `UPDATE agent_file_changes
        SET status='reverted',reverted_at=? WHERE run_id=? AND id=?`
          )
          .run(revertedAt, runId, changeId).changes > 0
      recomputeAgentChange(runId, workspaceId, revertedAt)
      db.exec('COMMIT')
      return changed
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'agent-change-recompute') {
    return recomputeAgentChange(
      text(args.runId, 'AGENT_RUN'),
      text(args.workspaceId, 'WORKSPACE'),
      timestamp(args.now, 'UPDATED_AT')
    )
  }
  if (method === 'agent-changes-delete-finalized-before') {
    const cutoff = timestamp(args.cutoff, 'AGENT_CHANGE_CUTOFF')
    db.exec('BEGIN IMMEDIATE')
    try {
      const where = "updated_at<? AND status='reverted'"
      const count = db
        .prepare(`SELECT COUNT(*) AS count FROM agent_change_sets WHERE ${where}`)
        .get(cutoff).count
      db.prepare(
        `DELETE FROM agent_file_changes WHERE run_id IN
         (SELECT run_id FROM agent_change_sets WHERE ${where})`
      ).run(cutoff)
      db.prepare(`DELETE FROM agent_change_sets WHERE ${where}`).run(cutoff)
      db.exec('COMMIT')
      return Number(count)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'runtime-job-submit') {
    const jobId = text(args.jobId, 'RUNTIME_JOB')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = nullableText(args.sessionId, 'SESSION')
    runtimeJobWorkspace(sessionId, workspaceId)
    const idempotencyKey = nullableText(args.idempotencyKey, 'IDEMPOTENCY_KEY')
    if (idempotencyKey) {
      const existing = db
        .prepare(
          `SELECT ${RUNTIME_JOB_COLUMNS} FROM runtime_jobs
           WHERE workspace_id=? AND idempotency_key=?`
        )
        .get(workspaceId, idempotencyKey)
      if (existing) return { accepted: false, duplicate: true, job: existing }
    }
    const now = timestamp(args.createdAt, 'CREATED_AT')
    db.prepare(
      `INSERT INTO runtime_jobs
       (job_id,run_id,session_id,method,state,idempotency_key,lane_key,params_json,
        created_at,updated_at,workspace_id)
       VALUES (?,?,?,?,'queued',?,?,?,?,?,?)`
    ).run(
      jobId,
      nullableText(args.runId, 'RUN'),
      sessionId,
      text(args.method, 'RUNTIME_METHOD'),
      idempotencyKey,
      nullableText(args.laneKey, 'LANE_KEY'),
      cronJson(args.paramsJson, 'RUNTIME_PARAMS'),
      now,
      now,
      workspaceId
    )
    return { accepted: true, duplicate: false, job: runtimeJob(jobId, workspaceId) }
  }
  if (method === 'runtime-job-get')
    return runtimeJob(text(args.jobId, 'RUNTIME_JOB'), text(args.workspaceId, 'WORKSPACE'))
  if (method === 'runtime-jobs-list')
    return db
      .prepare(
        `SELECT ${RUNTIME_JOB_COLUMNS} FROM runtime_jobs
         WHERE workspace_id=? ORDER BY created_at DESC,job_id DESC LIMIT ?`
      )
      .all(text(args.workspaceId, 'WORKSPACE'), page(args.limit, 100, 500))
  if (method === 'runtime-job-state' || method === 'runtime-job-cancel') {
    const jobId = text(args.jobId, 'RUNTIME_JOB')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const state = method === 'runtime-job-cancel' ? 'cancelled' : text(args.state, 'JOB_STATE')
    if (!['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(state))
      throw new Error('INVALID_BUSINESS_JOB_STATE')
    const now = timestamp(args.updatedAt, 'UPDATED_AT')
    db.prepare(
      `UPDATE runtime_jobs SET state=?,error_code=?,error_message=?,updated_at=?,
       finished_at=CASE WHEN ? THEN COALESCE(finished_at,?) ELSE finished_at END
       WHERE job_id=? AND workspace_id=?`
    ).run(
      state,
      method === 'runtime-job-cancel' ? 'cancelled' : nullableText(args.errorCode, 'ERROR_CODE'),
      method === 'runtime-job-cancel'
        ? 'Job cancellation requested.'
        : nullableCronText(args.errorMessage, 'ERROR_MESSAGE'),
      now,
      ['succeeded', 'failed', 'cancelled'].includes(state) ? 1 : 0,
      now,
      jobId,
      workspaceId
    )
    return runtimeJob(jobId, workspaceId)
  }
  if (method === 'runtime-job-event-append') {
    const jobId = text(args.jobId, 'RUNTIME_JOB')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!runtimeJob(jobId, workspaceId)) throw new Error('BUSINESS_RUNTIME_JOB_NOT_FOUND')
    db.prepare(
      `INSERT OR REPLACE INTO runtime_job_events
       (job_id,seq,payload_json,terminal,created_at) VALUES (?,?,?,?,?)`
    ).run(
      jobId,
      timestamp(args.seq, 'EVENT_SEQUENCE'),
      cronJson(args.payloadJson, 'EVENT_PAYLOAD'),
      bool(args.terminal, 'EVENT_TERMINAL'),
      timestamp(args.createdAt, 'CREATED_AT')
    )
    return true
  }
  if (method === 'runtime-job-events')
    return db
      .prepare(
        `SELECT e.job_id AS jobId,e.seq,e.payload_json AS payloadJson,
         e.terminal,e.created_at AS createdAt FROM runtime_job_events e
         JOIN runtime_jobs j ON j.job_id=e.job_id
         WHERE e.job_id=? AND j.workspace_id=? AND e.seq>?
         ORDER BY e.seq LIMIT ?`
      )
      .all(
        text(args.jobId, 'RUNTIME_JOB'),
        text(args.workspaceId, 'WORKSPACE'),
        timestamp(args.afterSeq ?? 0, 'AFTER_SEQUENCE'),
        page(args.limit, 1024, 4096)
      )
      .map((row) => ({ ...row, terminal: row.terminal !== 0 }))
  if (method === 'runtime-jobs-reap-stale') {
    const now = timestamp(args.now, 'NOW')
    const maxAgeMs = timestamp(args.maxAgeMs ?? 30 * 60 * 1000, 'MAX_AGE')
    if (maxAgeMs < 60_000 || maxAgeMs > 7 * 24 * 60 * 60 * 1000)
      throw new Error('INVALID_BUSINESS_MAX_AGE')
    const cutoffAt = now - maxAgeMs
    const result = db
      .prepare(
        `UPDATE runtime_jobs SET state='failed',error_code='stale_job',
       error_message='Execution host stopped reporting progress.',updated_at=?,
       finished_at=COALESCE(finished_at,?)
       WHERE state IN ('queued','running','cancelling') AND updated_at < ?`
      )
      .run(now, now, cutoffAt)
    return { reaped: Number(result.changes), cutoffAt }
  }
  if (method === 'sub-agent-history-index') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return subAgentHistoryRows(
      text(args.sessionId, 'SESSION'),
      workspaceId,
      Math.min(Math.max(args.limit ?? 100, 1), 500),
      0,
      false
    )
  }
  if (method === 'sub-agent-history-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200)
    const offsetValue = Math.max(args.offset ?? 0, 0)
    const rows = subAgentHistoryRows(
      text(args.sessionId, 'SESSION'),
      workspaceId,
      limit + 1,
      offsetValue,
      true
    )
    return { items: rows.slice(0, limit), offset: offsetValue, limit, hasMore: rows.length > limit }
  }
  if (method === 'sub-agent-history-apply') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return upsertSubAgentHistory(args, workspaceId)
  }
  if (method === 'sub-agent-history-replace') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    subAgentSession(sessionId, workspaceId)
    if (!Array.isArray(args.items)) throw new Error('INVALID_BUSINESS_SUB_AGENT_ITEMS')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM sub_agent_history WHERE session_id=?').run(sessionId)
      let changed = 0
      for (const item of args.items) {
        if (item?.sessionId !== sessionId) throw new Error('BUSINESS_SUB_AGENT_SESSION_MISMATCH')
        changed += upsertSubAgentHistory(item, workspaceId)
      }
      db.exec('COMMIT')
      return changed
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'sub-agent-history-migration-status') {
    const key = text(args.key, 'MIGRATION_KEY')
    const row = db.prepare('SELECT applied_at FROM app_migrations WHERE key=? LIMIT 1').get(key)
    return row ? { applied: true, appliedAt: row.applied_at } : { applied: false }
  }
  if (method === 'sub-agent-history-migration-mark') {
    const key = text(args.key, 'MIGRATION_KEY')
    const appliedAt = timestamp(args.appliedAt ?? Date.now(), 'MIGRATION_APPLIED_AT')
    return Number(
      db
        .prepare(
          'INSERT INTO app_migrations(key,applied_at) VALUES(?,?) ON CONFLICT(key) DO NOTHING'
        )
        .run(key, appliedAt).changes
    )
  }
  if (method === 'runtime-tool-result-upsert') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_TOOL_RESULT_SESSION_NOT_FOUND')
    db.prepare(
      `INSERT INTO runtime_tool_results (
      session_id,tool_use_id,run_id,tool_name,status,content_json,
      is_error,started_at,completed_at
    ) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,tool_use_id) DO UPDATE SET
      run_id=excluded.run_id,tool_name=excluded.tool_name,status=excluded.status,
      content_json=excluded.content_json,is_error=excluded.is_error,
      started_at=COALESCE(excluded.started_at,runtime_tool_results.started_at),
      completed_at=excluded.completed_at`
    ).run(
      sessionId,
      text(args.toolUseId, 'TOOL_USE'),
      text(args.runId, 'RUN'),
      text(args.toolName, 'TOOL_NAME'),
      text(args.status, 'TOOL_STATUS'),
      cronJson(args.contentJson, 'TOOL_CONTENT'),
      args.isError ? 1 : 0,
      nullableInteger(args.startedAt, 'STARTED_AT'),
      timestamp(args.completedAt, 'COMPLETED_AT')
    )
    return true
  }
  if (method === 'runtime-tool-results-lookup') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_TOOL_RESULT_SESSION_NOT_FOUND')
    if (!Array.isArray(args.toolUseIds)) throw new Error('INVALID_BUSINESS_TOOL_USE_IDS')
    const ids = [...new Set(args.toolUseIds.map((id) => text(id, 'TOOL_USE')))].slice(0, 256)
    if (ids.length === 0) return []
    return db
      .prepare(
        `SELECT session_id AS sessionId,tool_use_id AS toolUseId,
      run_id AS runId,tool_name AS toolName,status,content_json AS contentJson,
      is_error AS isError,started_at AS startedAt,completed_at AS completedAt
      FROM runtime_tool_results WHERE session_id=? AND tool_use_id IN (${ids.map(() => '?').join(',')})
      ORDER BY completed_at ASC`
      )
      .all(sessionId, ...ids)
  }
  if (method === 'draw-runs-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return db
      .prepare(
        `SELECT id,workspace_id,prompt,provider_name,model_name,mode,meta_json,
      created_at,is_generating,images_json,error_json,updated_at FROM draw_runs
      WHERE workspace_id=? ORDER BY created_at DESC,id DESC`
      )
      .all(workspaceId)
  }
  if (method === 'draw-run-save') {
    return saveDrawRun(args)
  }
  if (method === 'draw-sync-apply') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (
      !Array.isArray(args.records) ||
      !Array.isArray(args.deletedIds) ||
      args.records.length + args.deletedIds.length > 100_000
    )
      throw new Error('BUSINESS_DRAW_SYNC_BATCH_INVALID')
    let saved = 0
    let deleted = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of args.deletedIds) {
        deleted += db
          .prepare('DELETE FROM draw_runs WHERE id=? AND workspace_id=?')
          .run(text(id, 'DRAW_RUN'), workspaceId).changes
      }
      for (const record of args.records) {
        if (record.workspaceId !== workspaceId) throw new Error('BUSINESS_DRAW_WORKSPACE_MISMATCH')
        if (saveDrawRun(record)) saved++
      }
      db.exec('COMMIT')
      return { saved, deleted }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'workspace-draw-sync-validate-ids') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!Array.isArray(args.ids) || args.ids.length > 100_000)
      throw new Error('BUSINESS_DRAW_SYNC_BATCH_INVALID')
    const owner = db.prepare('SELECT workspace_id FROM draw_runs WHERE id=?')
    for (const id of args.ids) {
      const existing = owner.get(text(id, 'DRAW_RUN'))
      if (existing && existing.workspace_id !== workspaceId)
        throw new Error('BUSINESS_DRAW_WORKSPACE_MISMATCH')
    }
    return true
  }
  if (method === 'draw-run-delete') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return (
      db
        .prepare('DELETE FROM draw_runs WHERE id=? AND workspace_id=?')
        .run(text(args.id, 'DRAW_RUN'), workspaceId).changes > 0
    )
  }
  if (method === 'draw-runs-clear') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return Number(db.prepare('DELETE FROM draw_runs WHERE workspace_id=?').run(workspaceId).changes)
  }
  if (method === 'workspace-sync-capture') {
    const scopeHash = text(args.scopeHash, 'SYNC_SCOPE')
    if (!/^[a-f0-9]{64}$/.test(scopeHash)) throw new Error('BUSINESS_SYNC_SCOPE_INVALID')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const providerId = text(args.providerId, 'SYNC_PROVIDER')
    const deviceId = text(args.deviceId, 'SYNC_ORIGIN_DEVICE')
    const createdAt = timestamp(args.createdAt, 'SYNC_DELETED_AT')
    const schemas = workspaceSyncSchemas()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of ['ola_ts_sync_baselines_v2', 'ola_ts_sync_tombstones_v2']) {
        const existing = db
          .prepare(`SELECT workspace_id FROM ${table} WHERE scope_hash=? LIMIT 1`)
          .get(scopeHash)
        if (existing && existing.workspace_id !== workspaceId)
          throw new Error('BUSINESS_SYNC_WORKSPACE_MISMATCH')
      }
      const before = workspaceSyncState(scopeHash, workspaceId, providerId, schemas)
      const active = new Set(before.rows.map((row) => workspaceSyncKey(row.domain, row.recordId)))
      const insert = db.prepare(
        `INSERT INTO ola_ts_sync_tombstones_v2
         (scope_hash,workspace_id,provider_id,domain,record_id,deleted_at,origin_device_id)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(scope_hash,provider_id,domain,record_id) DO NOTHING`
      )
      for (const row of before.baseline) {
        if (active.has(workspaceSyncKey(row.domain, row.recordId))) continue
        insert.run(
          scopeHash,
          workspaceId,
          providerId,
          row.domain,
          row.recordId,
          createdAt,
          deviceId
        )
      }
      const state = workspaceSyncState(scopeHash, workspaceId, providerId, schemas)
      db.exec('COMMIT')
      return {
        scopeHash,
        records: state.rows,
        baseline: state.baseline,
        tombstones: state.tombstones,
        revisionToken: state.revisionToken
      }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'workspace-sync-commit') {
    const scopeHash = text(args.scopeHash, 'SYNC_SCOPE')
    const expectedRevisionToken = text(args.expectedRevisionToken, 'SYNC_REVISION')
    if (!/^[a-f0-9]{64}$/.test(scopeHash) || !/^[a-f0-9]{64}$/.test(expectedRevisionToken))
      throw new Error('BUSINESS_SYNC_SCOPE_INVALID')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const providerId = text(args.providerId, 'SYNC_PROVIDER')
    const syncedAt = timestamp(args.syncedAt, 'SYNCED_AT')
    if (
      !Array.isArray(args.records) ||
      !Array.isArray(args.deleted) ||
      !args.expectedBundle ||
      !Array.isArray(args.expectedBundle.records) ||
      !Array.isArray(args.expectedBundle.tombstones) ||
      !Array.isArray(args.baseline) ||
      !Array.isArray(args.tombstones) ||
      args.records.length > 100_000 ||
      args.deleted.length > 100_000 ||
      args.expectedBundle.records.length + args.expectedBundle.tombstones.length > 200_000
    )
      throw new Error('BUSINESS_SYNC_BATCH_INVALID')
    const schemas = workspaceSyncSchemas()
    const byName = new Map(schemas.map((schema) => [schema.name, schema]))
    const tableOrder = syncTableOrder(schemas)
    const orderIndex = new Map(tableOrder.map((name, index) => [name, index]))
    const recordsByTable = new Map()
    for (const record of args.records) {
      const tableName = syncTableFromDomain(record?.domain)
      const schema = byName.get(tableName)
      const row = record?.value?.row
      if (!schema || record?.value?.table !== tableName || !row || typeof row !== 'object')
        throw new Error('BUSINESS_SYNC_RECORD_INVALID')
      if (schema.columns.includes('workspace_id')) {
        if (row.workspace_id !== workspaceId) throw new Error('BUSINESS_SYNC_WORKSPACE_MISMATCH')
      } else if (record.workspaceId !== workspaceId) {
        throw new Error('BUSINESS_SYNC_WORKSPACE_MISMATCH')
      }
      if (workspaceSyncRecordId(schema, row) !== record.recordId)
        throw new Error('BUSINESS_SYNC_RECORD_INVALID')
      if (!recordsByTable.has(tableName)) recordsByTable.set(tableName, [])
      recordsByTable.get(tableName).push(row)
    }
    const deleted = args.deleted.map((item) => {
      const tableName = syncTableFromDomain(item?.domain)
      const schema = byName.get(tableName)
      if (!schema) throw new Error('BUSINESS_SYNC_RECORD_INVALID')
      const values = syncParseRecordId(text(item.recordId, 'SYNC_RECORD'))
      if (values.length !== schema.pk.length) throw new Error('BUSINESS_SYNC_RECORD_INVALID')
      return { tableName, schema, values }
    })
    const expectedRecords = new Map(
      args.expectedBundle.records.map((record) => [
        workspaceSyncKey(record.domain, record.recordId),
        record
      ])
    )
    for (const tombstone of args.expectedBundle.tombstones) {
      if (tombstone.workspaceId !== workspaceId) throw new Error('BUSINESS_SYNC_WORKSPACE_MISMATCH')
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of ['ola_ts_sync_baselines_v2', 'ola_ts_sync_tombstones_v2']) {
        const existing = db
          .prepare(`SELECT workspace_id FROM ${table} WHERE scope_hash=? LIMIT 1`)
          .get(scopeHash)
        if (existing && existing.workspace_id !== workspaceId)
          throw new Error('BUSINESS_SYNC_WORKSPACE_MISMATCH')
      }
      const before = workspaceSyncState(scopeHash, workspaceId, providerId, schemas)
      if (before.revisionToken !== expectedRevisionToken)
        throw new Error('BUSINESS_SYNC_LOCAL_CHANGED')

      for (const item of [...deleted].sort(
        (a, b) => (orderIndex.get(b.tableName) ?? 0) - (orderIndex.get(a.tableName) ?? 0)
      )) {
        const owner = workspaceSyncOwner(item.tableName, workspaceId)
        const where = item.schema.pk
          .map((column) => `${syncQuoteIdentifier(column)} IS ?`)
          .join(' AND ')
        db.prepare(
          `DELETE FROM ${syncQuoteIdentifier(item.tableName)} WHERE ${where} AND ${owner.sql}`
        ).run(...item.values, ...owner.params)
      }
      let saved = 0
      for (const tableName of [...recordsByTable.keys()].sort(
        (a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0)
      )) {
        const schema = byName.get(tableName)
        const columns = schema.columns
        const placeholders = columns.map(() => '?').join(',')
        const conflict = schema.pk.map(syncQuoteIdentifier).join(',')
        const updates = columns
          .filter((column) => !schema.pk.includes(column))
          .map((column) => `${syncQuoteIdentifier(column)}=excluded.${syncQuoteIdentifier(column)}`)
        const sql = `INSERT INTO ${syncQuoteIdentifier(tableName)} (${columns.map(syncQuoteIdentifier).join(',')}) VALUES (${placeholders}) ON CONFLICT(${conflict}) DO ${updates.length ? `UPDATE SET ${updates.join(',')}` : 'NOTHING'}`
        const statement = db.prepare(sql)
        for (const row of recordsByTable.get(tableName)) {
          statement.run(...columns.map((column) => syncSqlValue(row[column])))
          saved++
        }
      }
      const after = workspaceSyncState(scopeHash, workspaceId, providerId, schemas)
      const actual = new Map(
        after.rows.map((record) => [workspaceSyncKey(record.domain, record.recordId), record])
      )
      if (actual.size !== expectedRecords.size) throw new Error('BUSINESS_SYNC_RESULT_MISMATCH')
      for (const [itemKey, record] of expectedRecords) {
        const actualRecord = actual.get(itemKey)
        if (
          !actualRecord ||
          workspaceSyncHash(actualRecord.value) !== workspaceSyncHash(record.value)
        )
          throw new Error('BUSINESS_SYNC_RESULT_MISMATCH')
      }
      const baseline = args.baseline.map((row) => ({
        domain: text(row.domain, 'SYNC_DOMAIN'),
        recordId: text(row.recordId, 'SYNC_RECORD'),
        contentHash: text(row.contentHash, 'SYNC_HASH')
      }))
      const tombstones = args.tombstones.map((row) => {
        if (row.workspaceId !== workspaceId) throw new Error('BUSINESS_SYNC_WORKSPACE_MISMATCH')
        return {
          domain: text(row.domain, 'SYNC_DOMAIN'),
          recordId: text(row.recordId, 'SYNC_RECORD'),
          deletedAt: timestamp(row.deletedAt, 'SYNC_DELETED_AT'),
          originDeviceId: text(row.originDeviceId, 'SYNC_ORIGIN_DEVICE')
        }
      })
      db.prepare('DELETE FROM ola_ts_sync_baselines_v2 WHERE scope_hash=? AND provider_id=?').run(
        scopeHash,
        providerId
      )
      db.prepare('DELETE FROM ola_ts_sync_tombstones_v2 WHERE scope_hash=? AND provider_id=?').run(
        scopeHash,
        providerId
      )
      const insertBaseline = db.prepare(
        `INSERT INTO ola_ts_sync_baselines_v2
         (scope_hash,workspace_id,provider_id,domain,record_id,content_hash,synced_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      for (const row of baseline)
        insertBaseline.run(
          scopeHash,
          workspaceId,
          providerId,
          row.domain,
          row.recordId,
          row.contentHash,
          syncedAt
        )
      const insertTombstone = db.prepare(
        `INSERT INTO ola_ts_sync_tombstones_v2
         (scope_hash,workspace_id,provider_id,domain,record_id,deleted_at,origin_device_id)
         VALUES (?,?,?,?,?,?,?)`
      )
      for (const row of tombstones)
        insertTombstone.run(
          scopeHash,
          workspaceId,
          providerId,
          row.domain,
          row.recordId,
          row.deletedAt,
          row.originDeviceId
        )
      const revisionToken = workspaceSyncState(
        scopeHash,
        workspaceId,
        providerId,
        schemas
      ).revisionToken
      db.exec('COMMIT')
      return { saved, deleted: deleted.length, revisionToken }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'workspace-sync-metadata-get') {
    const scopeHash = text(args.scopeHash, 'SYNC_SCOPE')
    if (!/^[a-f0-9]{64}$/.test(scopeHash)) throw new Error('BUSINESS_SYNC_SCOPE_INVALID')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const providerId = text(args.providerId, 'SYNC_PROVIDER')
    return {
      baseline: db
        .prepare(
          `SELECT domain,record_id AS recordId,content_hash AS contentHash
           FROM ola_ts_sync_baselines_v2
           WHERE scope_hash=? AND workspace_id=? AND provider_id=?
           ORDER BY domain,record_id`
        )
        .all(scopeHash, workspaceId, providerId),
      tombstones: db
        .prepare(
          `SELECT domain,record_id AS recordId,deleted_at AS deletedAt,
                  origin_device_id AS originDeviceId,workspace_id AS workspaceId
           FROM ola_ts_sync_tombstones_v2
           WHERE scope_hash=? AND workspace_id=? AND provider_id=?
           ORDER BY domain,record_id`
        )
        .all(scopeHash, workspaceId, providerId)
    }
  }
  if (method === 'workspace-sync-metadata-save') {
    const scopeHash = text(args.scopeHash, 'SYNC_SCOPE')
    if (!/^[a-f0-9]{64}$/.test(scopeHash)) throw new Error('BUSINESS_SYNC_SCOPE_INVALID')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const providerId = text(args.providerId, 'SYNC_PROVIDER')
    const syncedAt = timestamp(args.syncedAt, 'SYNCED_AT')
    if (
      !Array.isArray(args.baseline) ||
      !Array.isArray(args.tombstones) ||
      args.baseline.length + args.tombstones.length > 100_000
    )
      throw new Error('BUSINESS_SYNC_METADATA_INVALID')
    const baseline = args.baseline.map((row) => {
      const domain = text(row.domain, 'SYNC_DOMAIN')
      const recordId = text(row.recordId, 'SYNC_RECORD')
      const contentHash = text(row.contentHash, 'SYNC_HASH')
      if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('BUSINESS_SYNC_METADATA_INVALID')
      return { domain, recordId, contentHash }
    })
    const tombstones = args.tombstones.map((row) => {
      if (row.workspaceId !== workspaceId) throw new Error('BUSINESS_SYNC_WORKSPACE_MISMATCH')
      return {
        domain: text(row.domain, 'SYNC_DOMAIN'),
        recordId: text(row.recordId, 'SYNC_RECORD'),
        deletedAt: timestamp(row.deletedAt, 'SYNC_DELETED_AT'),
        originDeviceId: text(row.originDeviceId, 'SYNC_ORIGIN_DEVICE')
      }
    })
    for (const table of ['ola_ts_sync_baselines_v2', 'ola_ts_sync_tombstones_v2']) {
      const existing = db
        .prepare(`SELECT workspace_id FROM ${table} WHERE scope_hash=? LIMIT 1`)
        .get(scopeHash)
      if (existing && existing.workspace_id !== workspaceId)
        throw new Error('BUSINESS_SYNC_WORKSPACE_MISMATCH')
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM ola_ts_sync_baselines_v2 WHERE scope_hash=? AND provider_id=?').run(
        scopeHash,
        providerId
      )
      db.prepare('DELETE FROM ola_ts_sync_tombstones_v2 WHERE scope_hash=? AND provider_id=?').run(
        scopeHash,
        providerId
      )
      const insertBaseline = db.prepare(
        `INSERT INTO ola_ts_sync_baselines_v2
         (scope_hash,workspace_id,provider_id,domain,record_id,content_hash,synced_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      for (const row of baseline)
        insertBaseline.run(
          scopeHash,
          workspaceId,
          providerId,
          row.domain,
          row.recordId,
          row.contentHash,
          syncedAt
        )
      const insertTombstone = db.prepare(
        `INSERT INTO ola_ts_sync_tombstones_v2
         (scope_hash,workspace_id,provider_id,domain,record_id,deleted_at,origin_device_id)
         VALUES (?,?,?,?,?,?,?)`
      )
      for (const row of tombstones)
        insertTombstone.run(
          scopeHash,
          workspaceId,
          providerId,
          row.domain,
          row.recordId,
          row.deletedAt,
          row.originDeviceId
        )
      db.exec('COMMIT')
      return
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'workspace-draw-sync-capture') {
    const scopeHash = text(args.scopeHash, 'SYNC_SCOPE')
    if (!/^[a-f0-9]{64}$/.test(scopeHash)) throw new Error('BUSINESS_SYNC_SCOPE_INVALID')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const providerId = text(args.providerId, 'SYNC_PROVIDER')
    const deviceId = text(args.deviceId, 'SYNC_ORIGIN_DEVICE')
    const createdAt = timestamp(args.createdAt, 'SYNC_DELETED_AT')
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of ['ola_ts_sync_baselines_v2', 'ola_ts_sync_tombstones_v2']) {
        const existing = db
          .prepare(`SELECT workspace_id FROM ${table} WHERE scope_hash=? LIMIT 1`)
          .get(scopeHash)
        if (existing && existing.workspace_id !== workspaceId)
          throw new Error('BUSINESS_SYNC_WORKSPACE_MISMATCH')
      }
      const before = workspaceDrawSyncState(scopeHash, workspaceId, providerId)
      const activeIds = new Set(before.rows.map((row) => row.id))
      const insert = db.prepare(
        `INSERT INTO ola_ts_sync_tombstones_v2
         (scope_hash,workspace_id,provider_id,domain,record_id,deleted_at,origin_device_id)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(scope_hash,provider_id,domain,record_id) DO NOTHING`
      )
      for (const row of before.baseline) {
        if (activeIds.has(row.recordId)) continue
        insert.run(
          scopeHash,
          workspaceId,
          providerId,
          'db:draw_runs',
          row.recordId,
          createdAt,
          deviceId
        )
      }
      const state = workspaceDrawSyncState(scopeHash, workspaceId, providerId)
      const tombstones = state.storedTombstones.filter((row) => !activeIds.has(row.recordId))
      db.exec('COMMIT')
      return {
        rows: state.rows,
        tombstones,
        baseline: state.baseline,
        revisionToken: state.revisionToken
      }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'workspace-draw-sync-commit') {
    const scopeHash = text(args.scopeHash, 'SYNC_SCOPE')
    const expectedRevisionToken = text(args.expectedRevisionToken, 'SYNC_REVISION')
    if (!/^[a-f0-9]{64}$/.test(scopeHash) || !/^[a-f0-9]{64}$/.test(expectedRevisionToken))
      throw new Error('BUSINESS_SYNC_SCOPE_INVALID')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const providerId = text(args.providerId, 'SYNC_PROVIDER')
    const syncedAt = timestamp(args.syncedAt, 'SYNCED_AT')
    if (
      !Array.isArray(args.records) ||
      !Array.isArray(args.deletedIds) ||
      !Array.isArray(args.expectedRows) ||
      !Array.isArray(args.baseline) ||
      !Array.isArray(args.tombstones) ||
      args.records.length + args.deletedIds.length > 100_000 ||
      args.expectedRows.length + args.baseline.length + args.tombstones.length > 300_000
    )
      throw new Error('BUSINESS_DRAW_SYNC_BATCH_INVALID')
    const baseline = args.baseline.map((row) => {
      if (row.domain !== 'db:draw_runs' || !/^[a-f0-9]{64}$/.test(row.contentHash))
        throw new Error('BUSINESS_SYNC_METADATA_INVALID')
      return { recordId: text(row.recordId, 'SYNC_RECORD'), contentHash: row.contentHash }
    })
    const tombstones = args.tombstones.map((row) => {
      if (row.domain !== 'db:draw_runs' || row.workspaceId !== workspaceId)
        throw new Error('BUSINESS_SYNC_WORKSPACE_MISMATCH')
      return {
        recordId: text(row.recordId, 'SYNC_RECORD'),
        deletedAt: timestamp(row.deletedAt, 'SYNC_DELETED_AT'),
        originDeviceId: text(row.originDeviceId, 'SYNC_ORIGIN_DEVICE')
      }
    })
    let saved = 0
    let deleted = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of ['ola_ts_sync_baselines_v2', 'ola_ts_sync_tombstones_v2']) {
        const existing = db
          .prepare(`SELECT workspace_id FROM ${table} WHERE scope_hash=? LIMIT 1`)
          .get(scopeHash)
        if (existing && existing.workspace_id !== workspaceId)
          throw new Error('BUSINESS_SYNC_WORKSPACE_MISMATCH')
      }
      if (
        workspaceDrawSyncState(scopeHash, workspaceId, providerId).revisionToken !==
        expectedRevisionToken
      )
        throw new Error('BUSINESS_DRAW_SYNC_LOCAL_CHANGED')
      for (const id of args.deletedIds)
        deleted += db
          .prepare('DELETE FROM draw_runs WHERE id=? AND workspace_id=?')
          .run(text(id, 'DRAW_RUN'), workspaceId).changes
      for (const record of args.records) {
        if (record.workspaceId !== workspaceId) throw new Error('BUSINESS_DRAW_WORKSPACE_MISMATCH')
        if (saveDrawRun(record)) saved++
      }
      const actualRows = workspaceDrawSyncState(scopeHash, workspaceId, providerId).rows
      if (!equalDrawRows(actualRows, args.expectedRows))
        throw new Error('BUSINESS_DRAW_SYNC_RESULT_MISMATCH')
      const rowIds = new Set(actualRows.map((row) => row.id))
      if (
        rowIds.size !== baseline.length ||
        new Set(baseline.map((row) => row.recordId)).size !== baseline.length ||
        baseline.some((row) => !rowIds.has(row.recordId)) ||
        tombstones.some((row) => rowIds.has(row.recordId))
      )
        throw new Error('BUSINESS_DRAW_SYNC_METADATA_INVALID')
      db.prepare(
        "DELETE FROM ola_ts_sync_baselines_v2 WHERE scope_hash=? AND provider_id=? AND domain='db:draw_runs'"
      ).run(scopeHash, providerId)
      db.prepare(
        "DELETE FROM ola_ts_sync_tombstones_v2 WHERE scope_hash=? AND provider_id=? AND domain='db:draw_runs'"
      ).run(scopeHash, providerId)
      const insertBaseline = db.prepare(
        `INSERT INTO ola_ts_sync_baselines_v2
         (scope_hash,workspace_id,provider_id,domain,record_id,content_hash,synced_at)
         VALUES (?,?,?,'db:draw_runs',?,?,?)`
      )
      for (const row of baseline)
        insertBaseline.run(
          scopeHash,
          workspaceId,
          providerId,
          row.recordId,
          row.contentHash,
          syncedAt
        )
      const insertTombstone = db.prepare(
        `INSERT INTO ola_ts_sync_tombstones_v2
         (scope_hash,workspace_id,provider_id,domain,record_id,deleted_at,origin_device_id)
         VALUES (?,?,?,'db:draw_runs',?,?,?)`
      )
      for (const row of tombstones)
        insertTombstone.run(
          scopeHash,
          workspaceId,
          providerId,
          row.recordId,
          row.deletedAt,
          row.originDeviceId
        )
      const revisionToken = workspaceDrawSyncState(scopeHash, workspaceId, providerId).revisionToken
      db.exec('COMMIT')
      return { saved, deleted, revisionToken }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'usage-event-add') return addUsageEvent(args)
  if (method === 'usage-query-raw') return queryRawUsage(args.operation, args)
  if (method === 'usage-query-activity') return queryActivityUsage(args.operation, args)
  if (method === 'usage-events-delete') {
    const { clause, values } = usageFilter(args)
    return Number(db.prepare(`DELETE FROM usage_events ${clause}`).run(...values).changes)
  }
  if (method === 'usage-maintain') return maintainUsage(args.cutoff)
  if (method === 'usage-events-list') {
    const { clause, values } = usageFilter(args)
    const visibleColumns = USAGE_EVENT_COLUMNS.filter(
      (column) => !['request_debug_json', 'usage_raw_json', 'meta_json'].includes(column)
    ).join(',')
    return db
      .prepare(
        `SELECT ${visibleColumns},
          LENGTH(COALESCE(request_debug_json,'')) AS request_debug_chars,
          LENGTH(COALESCE(usage_raw_json,'')) AS usage_raw_chars,
          LENGTH(COALESCE(meta_json,'')) AS meta_chars
         FROM usage_events ${clause}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...values, page(args.limit), offset(args.offset))
  }
  if (method === 'usage-activity-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const fromDay = usageDay(args.fromDay)
    const toDay = usageDay(args.toDay)
    if (toDay < fromDay) throw new Error('INVALID_BUSINESS_USAGE_RANGE')
    const table = {
      daily: 'usage_activity_daily_v2',
      models: 'usage_activity_daily_models_v2',
      providers: 'usage_activity_daily_providers_v2'
    }[args.dimension]
    if (!table) throw new Error('INVALID_BUSINESS_USAGE_DIMENSION')
    const orderBy =
      args.dimension === 'daily'
        ? 'day DESC'
        : args.dimension === 'models'
          ? 'day DESC, provider_id ASC, model_id ASC'
          : 'day DESC, provider_id ASC'
    return db
      .prepare(
        `SELECT * FROM ${table} WHERE workspace_id=? AND day>=? AND day<=?
         ORDER BY ${orderBy} LIMIT ? OFFSET ?`
      )
      .all(workspaceId, fromDay, toDay, page(args.limit), offset(args.offset))
  }
  if (method === 'sessions-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return db
      .prepare(
        `SELECT id, title, icon, mode, created_at, updated_at, project_id, working_folder,
                ssh_connection_id, plan_id, pinned, plugin_id, external_chat_id, provider_id,
                model_id, model_selection_mode, model_source, task_profile, task_profile_locked,
                scenario_policy,
                workspace_id, message_count
           FROM sessions WHERE workspace_id=?
          ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(workspaceId, page(args.limit), offset(args.offset))
  }
  if (method === 'session-get')
    return session(text(args.id, 'SESSION'), text(args.workspaceId, 'WORKSPACE'))
  if (method === 'session-status') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const row = db
      .prepare(
        `SELECT s.title, s.created_at, s.updated_at, COUNT(m.id) AS message_count
           FROM sessions s LEFT JOIN messages m ON m.session_id=s.id
          WHERE s.id=? AND s.workspace_id=?
          GROUP BY s.id LIMIT 1`
      )
      .get(sessionId, workspaceId)
    if (!row) return { success: true, found: false, messageCount: 0 }
    return {
      success: true,
      found: true,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count
    }
  }
  if (method === 'session-usage-stats') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const rows = db
      .prepare(
        `SELECT m.usage, m.created_at
           FROM messages m JOIN sessions s ON s.id=m.session_id
          WHERE m.session_id=? AND s.workspace_id=? AND m.role='assistant'
            AND m.usage IS NOT NULL
          ORDER BY m.created_at ASC`
      )
      .all(sessionId, workspaceId)
    const result = {
      success: true,
      hasUsage: false,
      totalInput: 0,
      totalOutput: 0,
      totalCacheCreation: 0,
      totalCacheRead: 0,
      totalReasoning: 0,
      totalDurationMs: 0,
      requestCount: 0,
      assistantReplies: 0
    }
    for (const row of rows) {
      if (typeof row.usage !== 'string' || !row.usage.trim()) continue
      try {
        const usage = JSON.parse(row.usage)
        if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue
        const input = usageNumber(usage.inputTokens) ?? 0
        const cacheRead = usageNumber(usage.cacheReadTokens) ?? 0
        const cacheCreation = usageNumber(usage.cacheCreationTokens) ?? 0
        result.totalInput +=
          usageNumber(usage.billableInputTokens) ??
          Math.max(0, input - Math.max(0, cacheRead) - Math.max(0, cacheCreation))
        result.totalOutput += usageNumber(usage.outputTokens) ?? 0
        result.totalCacheCreation += cacheCreation
        result.totalCacheRead += cacheRead
        result.totalReasoning += usageNumber(usage.reasoningTokens) ?? 0
        result.totalDurationMs += usageNumber(usage.totalDurationMs) ?? 0
        result.requestCount += Array.isArray(usage.requestTimings) ? usage.requestTimings.length : 1
        result.assistantReplies++
        if (result.assistantReplies === 1) result.firstCreatedAt = row.created_at
        result.lastCreatedAt = row.created_at
      } catch {
        // A malformed historical usage payload is ignored like the Native accumulator.
      }
    }
    result.hasUsage = result.assistantReplies > 0
    return result
  }
  if (method === 'session-compact-messages') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const messages = db
      .prepare(
        `SELECT m.id, m.content FROM messages m JOIN sessions s ON s.id=m.session_id
          WHERE m.session_id=? AND s.workspace_id=? ORDER BY m.created_at ASC`
      )
      .all(sessionId, workspaceId)
    if (messages.length < 6) return { success: true, totalMessages: messages.length, compacted: 0 }
    const cutoff = messages.length - 6
    let compacted = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      const update = db.prepare(
        `UPDATE messages SET content=? WHERE id=? AND session_id=?
         AND session_id IN (SELECT id FROM sessions WHERE workspace_id=?)`
      )
      for (let index = 0; index < cutoff; index++) {
        const content = compactMessageContent(messages[index].content)
        if (content === null) continue
        compacted += update.run(content, messages[index].id, sessionId, workspaceId).changes
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { success: true, totalMessages: messages.length, compacted }
  }
  if (method === 'channel-sessions-list') {
    return db
      .prepare(
        `SELECT id,title,icon,mode,created_at,updated_at,project_id,working_folder,
      ssh_connection_id,plan_id,pinned,plugin_id,external_chat_id,provider_id,model_id,
      model_selection_mode,task_profile,task_profile_locked,scenario_policy,message_count,workspace_id FROM sessions
      WHERE plugin_id=? AND workspace_id=? ORDER BY updated_at DESC,id DESC`
      )
      .all(text(args.pluginId, 'PLUGIN'), text(args.workspaceId, 'WORKSPACE'))
  }
  if (method === 'channel-sessions-list-all') {
    return db
      .prepare(
        `SELECT id,title,icon,mode,created_at,updated_at,project_id,working_folder,
      ssh_connection_id,plan_id,pinned,plugin_id,external_chat_id,provider_id,model_id,
      model_selection_mode,task_profile,task_profile_locked,scenario_policy,message_count,workspace_id FROM sessions
      WHERE plugin_id IS NOT NULL AND plugin_id!='' AND workspace_id=?
      ORDER BY updated_at DESC,id DESC`
      )
      .all(text(args.workspaceId, 'WORKSPACE'))
  }
  if (method === 'channel-session-find-chat') {
    return (
      db
        .prepare(
          `SELECT id,title,icon,mode,created_at,updated_at,project_id,working_folder,
      ssh_connection_id,plan_id,pinned,plugin_id,external_chat_id,provider_id,model_id,
      model_selection_mode,task_profile,task_profile_locked,scenario_policy,message_count,workspace_id FROM sessions
      WHERE external_chat_id=? AND workspace_id=?
        AND plugin_id IS NOT NULL AND plugin_id!='' LIMIT 1`
        )
        .get(text(args.externalChatId, 'EXTERNAL_CHAT'), text(args.workspaceId, 'WORKSPACE')) ??
      null
    )
  }
  if (method === 'channel-session-messages') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!channelSession(sessionId, workspaceId)) return []
    return db
      .prepare(
        `SELECT id,role,content,created_at FROM messages
       WHERE session_id=? ORDER BY sort_order ASC LIMIT ? OFFSET ?`
      )
      .all(sessionId, page(args.limit, 50, 500), offset(args.offset))
  }
  if (method === 'channel-session-status') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const row = db
      .prepare(
        `SELECT s.title, s.created_at, s.updated_at, COUNT(m.id) AS message_count
           FROM sessions s LEFT JOIN messages m ON m.session_id=s.id
          WHERE s.id=? AND s.workspace_id=? GROUP BY s.id LIMIT 1`
      )
      .get(sessionId, workspaceId)
    if (!row) return { success: true, found: false, messageCount: 0 }
    return {
      success: true,
      found: true,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count
    }
  }
  if (method === 'channel-session-usage-stats') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const rows = db
      .prepare(
        `SELECT m.usage, m.created_at FROM messages m JOIN sessions s ON s.id=m.session_id
          WHERE m.session_id=? AND s.workspace_id=? AND m.role='assistant'
            AND m.usage IS NOT NULL ORDER BY m.created_at ASC`
      )
      .all(sessionId, workspaceId)
    const result = {
      success: true,
      hasUsage: false,
      totalInput: 0,
      totalOutput: 0,
      totalCacheCreation: 0,
      totalCacheRead: 0,
      totalReasoning: 0,
      totalDurationMs: 0,
      requestCount: 0,
      assistantReplies: 0
    }
    for (const row of rows) {
      if (typeof row.usage !== 'string' || !row.usage.trim()) continue
      try {
        const usage = JSON.parse(row.usage)
        if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue
        const input = usageNumber(usage.inputTokens) ?? 0
        const cacheRead = usageNumber(usage.cacheReadTokens) ?? 0
        const cacheCreation = usageNumber(usage.cacheCreationTokens) ?? 0
        result.totalInput +=
          usageNumber(usage.billableInputTokens) ??
          Math.max(0, input - Math.max(0, cacheRead) - Math.max(0, cacheCreation))
        result.totalOutput += usageNumber(usage.outputTokens) ?? 0
        result.totalCacheCreation += cacheCreation
        result.totalCacheRead += cacheRead
        result.totalReasoning += usageNumber(usage.reasoningTokens) ?? 0
        result.totalDurationMs += usageNumber(usage.totalDurationMs) ?? 0
        result.requestCount += Array.isArray(usage.requestTimings) ? usage.requestTimings.length : 1
        result.assistantReplies++
        if (result.assistantReplies === 1) result.firstCreatedAt = row.created_at
        result.lastCreatedAt = row.created_at
      } catch {
        // Historical malformed usage rows are intentionally ignored.
      }
    }
    result.hasUsage = result.assistantReplies > 0
    return result
  }
  if (method === 'projects-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return db
      .prepare(
        `SELECT id, name, working_folder, ssh_connection_id, plugin_id, pinned, created_at,
                updated_at, workspace_id, model_source
           FROM projects WHERE workspace_id=?
          ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(workspaceId, page(args.limit), offset(args.offset))
  }
  if (method === 'project-get') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return (
      db
        .prepare(
          `SELECT id, name, working_folder, ssh_connection_id, plugin_id, pinned, created_at,
                  updated_at, workspace_id, model_source
             FROM projects WHERE id=? AND workspace_id=?`
        )
        .get(text(args.id, 'PROJECT'), workspaceId) ?? null
    )
  }
  if (method === 'project-find-by-plugin') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return (
      db
        .prepare(
          `SELECT id, name, working_folder, ssh_connection_id, plugin_id, pinned, created_at,
                  updated_at, workspace_id, model_source
             FROM projects WHERE plugin_id=? AND workspace_id=?
            ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT 1`
        )
        .get(text(args.pluginId, 'PLUGIN'), workspaceId) ?? null
    )
  }
  if (method === 'plugin-normal-projects') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return db
      .prepare(
        `SELECT id,name,working_folder,ssh_connection_id,plugin_id,pinned,created_at,
                updated_at,workspace_id
           FROM projects
          WHERE workspace_id=? AND (plugin_id IS NULL OR plugin_id='')
          ORDER BY pinned DESC,updated_at DESC,id DESC`
      )
      .all(workspaceId)
  }
  if (method === 'plugin-sync-session-models') {
    const workspaceId = text(args.workspaceId ?? 'local-personal', 'WORKSPACE')
    const pluginId = text(args.pluginId, 'PLUGIN')
    const providerId = sessionProviderId(args.providerId, workspaceId)
    const modelId = providerId ? normalizedOptionalText(args.modelId, 'MODEL') : null
    const modelSource =
      args.modelSource == null ? null : channelModelSource(args.modelSource, workspaceId)
    const changed = db
      .prepare(
        `UPDATE sessions SET provider_id=?,model_id=?,model_source=?,model_selection_mode=?
          WHERE plugin_id=? AND workspace_id=?`
      )
      .run(
        providerId,
        modelId,
        modelSource,
        providerId && modelId ? 'manual' : 'inherit',
        pluginId,
        workspaceId
      ).changes
    return { success: true, changed, deleted: 0, error: null }
  }
  if (method === 'plugin-sync-session-project') {
    const workspaceId = text(args.workspaceId ?? 'local-personal', 'WORKSPACE')
    const pluginId = text(args.pluginId, 'PLUGIN')
    const projectId = normalizedOptionalText(args.projectId, 'PROJECT')
    const project = projectId
      ? db
          .prepare(
            'SELECT id,working_folder,ssh_connection_id,workspace_id FROM projects WHERE id=?'
          )
          .get(projectId)
      : null
    if (project && project.workspace_id !== workspaceId)
      throw new Error('BUSINESS_PLUGIN_PROJECT_WORKSPACE_MISMATCH')
    const changed = db
      .prepare(
        `UPDATE sessions SET project_id=?,working_folder=?,ssh_connection_id=?
          WHERE plugin_id=? AND workspace_id=?`
      )
      .run(
        project?.id ?? null,
        project?.working_folder ?? null,
        project?.ssh_connection_id ?? null,
        pluginId,
        workspaceId
      ).changes
    return { success: true, changed, deleted: 0, error: null }
  }
  if (method === 'plugin-remove-data') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const pluginId = text(args.pluginId, 'PLUGIN')
    db.exec('BEGIN IMMEDIATE')
    try {
      const deleted = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM messages WHERE session_id IN
             (SELECT id FROM sessions WHERE plugin_id=? AND workspace_id=?)`
          )
          .get(pluginId, workspaceId).count
      )
      const changed =
        Number(
          db
            .prepare('DELETE FROM sessions WHERE plugin_id=? AND workspace_id=?')
            .run(pluginId, workspaceId).changes
        ) +
        Number(
          db
            .prepare('DELETE FROM projects WHERE plugin_id=? AND workspace_id=?')
            .run(pluginId, workspaceId).changes
        )
      db.exec('COMMIT')
      return { success: true, changed, deleted, error: null }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'messages-list') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!session(sessionId, workspaceId)) return []
    normalizeSessionMessageSortOrders(sessionId)
    return db
      .prepare(
        `SELECT id, session_id, role, content, meta, created_at, usage, sort_order
           FROM messages WHERE session_id=? ORDER BY sort_order ASC, created_at ASC`
      )
      .all(sessionId)
  }
  if (method === 'messages-list-user') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!session(sessionId, workspaceId)) return []
    normalizeSessionMessageSortOrders(sessionId)
    return db
      .prepare(
        `SELECT id, session_id, role, content, meta, created_at, usage, sort_order
           FROM messages WHERE session_id=? AND role='user'
          ORDER BY sort_order ASC, created_at ASC`
      )
      .all(sessionId)
  }
  if (method === 'messages-list-locator') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!session(sessionId, workspaceId)) return []
    normalizeSessionMessageSortOrders(sessionId)
    return db
      .prepare(
        `SELECT id, session_id, role, content, meta, created_at, sort_order
           FROM messages WHERE session_id=? ORDER BY sort_order ASC, created_at ASC`
      )
      .all(sessionId)
  }
  if (method === 'messages-list-markers') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!session(sessionId, workspaceId)) return []
    normalizeSessionMessageSortOrders(sessionId)
    return db
      .prepare(
        `SELECT id, session_id, role, substr(content, 1, 512) AS content, meta,
                created_at, NULL AS usage, sort_order
           FROM messages WHERE session_id=? AND role IN ('user', 'assistant')
          ORDER BY sort_order ASC, created_at ASC`
      )
      .all(sessionId)
  }
  if (method === 'messages-list-page') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!session(sessionId, workspaceId)) return []
    normalizeSessionMessageSortOrders(sessionId)
    return db
      .prepare(
        `SELECT id, session_id, role, content, meta, created_at, usage, sort_order
           FROM messages WHERE session_id=?
          ORDER BY sort_order ASC, created_at ASC LIMIT ? OFFSET ?`
      )
      .all(sessionId, page(args.limit), offset(args.offset))
  }
  if (method === 'messages-count') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!session(sessionId, workspaceId)) return 0
    return Number(
      db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(sessionId)
        ?.count ?? 0
    )
  }
  if (method === 'messages-request-context') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const maxMessages = contextLimit(args.maxMessages, 160)
    const requestedHeadLimit = Math.min(contextLimit(args.headLimit, 12), maxMessages)
    if (!session(sessionId, workspaceId)) return []
    normalizeSessionMessageSortOrders(sessionId)
    const total = Number(
      db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(sessionId)
        ?.count ?? 0
    )
    if (!total) return []
    const headLimit =
      total > maxMessages ? Math.min(requestedHeadLimit, Math.floor(maxMessages / 4)) : 0
    const tailLimit = Math.min(Math.max(1, maxMessages - headLimit), total)
    const pageRows = (limit, start) =>
      db
        .prepare(
          `SELECT id, session_id, role, content, meta, created_at, usage, sort_order
             FROM messages WHERE session_id=? ORDER BY sort_order ASC, created_at ASC LIMIT ? OFFSET ?`
        )
        .all(sessionId, limit, start)
    const rows = [
      ...(headLimit ? pageRows(headLimit, 0) : []),
      ...db
        .prepare(
          `SELECT id, session_id, role, content, meta, created_at, usage, sort_order
             FROM messages WHERE session_id=?
               AND (meta LIKE '%compactBoundary%' OR meta LIKE '%compactSummary%'
                 OR content LIKE '%[Context Memory Compressed Summary]%')
             ORDER BY sort_order ASC, created_at ASC`
        )
        .all(sessionId),
      ...pageRows(tailLimit, Math.max(0, total - tailLimit))
    ]
    const seen = new Set()
    return rows
      .sort(
        (left, right) => left.sort_order - right.sort_order || left.created_at - right.created_at
      )
      .filter((row) => !seen.has(row.id) && seen.add(row.id))
  }
  if (method === 'messages-window-around') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const windowLimit = page(args.limit, 30, 5000)
    if (!session(sessionId, workspaceId))
      return { success: true, rows: [], start: 0, end: 0, total: 0, anchorSortOrder: 0 }
    normalizeSessionMessageSortOrders(sessionId)
    const total = Number(
      db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(sessionId)
        ?.count ?? 0
    )
    if (!total) return { success: true, rows: [], start: 0, end: 0, total: 0, anchorSortOrder: 0 }
    let anchor = -1
    if (typeof args.messageId === 'string' && args.messageId.trim()) {
      const row = db
        .prepare('SELECT sort_order FROM messages WHERE session_id=? AND id=? LIMIT 1')
        .get(sessionId, args.messageId.trim())
      if (row?.sort_order !== undefined) anchor = Number(row.sort_order)
    }
    if (anchor < 0 && Number.isSafeInteger(args.sortOrder) && args.sortOrder >= 0)
      anchor = args.sortOrder
    anchor = Math.min(Math.max(anchor < 0 ? total - 1 : anchor, 0), total - 1)
    const start = Math.min(
      Math.max(anchor - Math.floor(windowLimit / 2), 0),
      Math.max(0, total - windowLimit)
    )
    const rows = db
      .prepare(
        `SELECT id, session_id, role, content, meta, created_at, usage, sort_order
           FROM messages WHERE session_id=? ORDER BY sort_order ASC, created_at ASC LIMIT ? OFFSET ?`
      )
      .all(sessionId, windowLimit, start)
    return { success: true, rows, start, end: start + rows.length, total, anchorSortOrder: anchor }
  }
  if (method === 'messages-search-content') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const query = searchQuery(args.query)
    return db
      .prepare(
        `SELECT m.session_id AS session_id, m.content AS snippet
           FROM messages m
           JOIN sessions s ON s.id=m.session_id
           JOIN (
             SELECT m2.session_id, MIN(m2.sort_order) AS sort_order
               FROM messages m2 JOIN sessions s2 ON s2.id=m2.session_id
              WHERE s2.workspace_id=? AND m2.content LIKE ? ESCAPE '\\'
              GROUP BY m2.session_id
           ) first_match ON first_match.session_id=m.session_id
                        AND first_match.sort_order=m.sort_order
          WHERE s.workspace_id=?
          ORDER BY m.session_id ASC LIMIT ?`
      )
      .all(
        workspaceId,
        '%' + escapeLike(query) + '%',
        workspaceId,
        contextLimit(args.limit, 50, 200)
      )
  }
  if (method === 'tasks-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return db
      .prepare(
        `SELECT t.id, t.session_id, t.plan_id, t.subject, t.description, t.active_form,
                t.status, t.owner, t.blocks, t.blocked_by, t.metadata, t.sort_order,
                t.created_at, t.updated_at
           FROM tasks t JOIN sessions s ON s.id=t.session_id WHERE s.workspace_id=?
          ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`
      )
      .all(workspaceId, page(args.limit), offset(args.offset))
  }
  if (method === 'tasks-list-session') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!session(sessionId, workspaceId)) return []
    return db
      .prepare(
        `SELECT id, session_id, plan_id, subject, description, active_form, status, owner, blocks,
                blocked_by, metadata, sort_order, created_at, updated_at
           FROM tasks WHERE session_id=? ORDER BY sort_order ASC, created_at ASC LIMIT ? OFFSET ?`
      )
      .all(sessionId, page(args.limit), offset(args.offset))
  }
  if (method === 'task-get') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return (
      db
        .prepare(
          `SELECT t.id, t.session_id, t.plan_id, t.subject, t.description, t.active_form,
                  t.status, t.owner, t.blocks, t.blocked_by, t.metadata, t.sort_order,
                  t.created_at, t.updated_at
             FROM tasks t JOIN sessions s ON s.id=t.session_id
            WHERE t.id=? AND s.workspace_id=?`
        )
        .get(text(args.id, 'TASK'), workspaceId) ?? null
    )
  }
  if (method === 'plans-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return db
      .prepare(
        `SELECT p.id, p.session_id, p.title, p.status, p.file_path, p.content, p.spec_json,
                p.created_at, p.updated_at, s.workspace_id
           FROM plans p JOIN sessions s ON s.id=p.session_id WHERE s.workspace_id=?
          ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`
      )
      .all(workspaceId, page(args.limit), offset(args.offset))
  }
  if (method === 'plan-get') return plan(text(args.id, 'PLAN'), text(args.workspaceId, 'WORKSPACE'))
  if (method === 'plan-get-by-session') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    return (
      db
        .prepare(
          `SELECT p.id, p.session_id, p.title, p.status, p.file_path, p.content, p.spec_json,
                  p.created_at, p.updated_at, s.workspace_id
             FROM plans p JOIN sessions s ON s.id=p.session_id
            WHERE p.session_id=? AND s.workspace_id=?
            ORDER BY p.updated_at DESC LIMIT 1`
        )
        .get(sessionId, workspaceId) ?? null
    )
  }
  if (method === 'goals-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (args.limit === undefined && args.offset === undefined) {
      return db
        .prepare(
          `SELECT g.session_id, g.goal_id, g.objective, g.status, g.token_budget, g.tokens_used,
                  g.time_used_seconds, g.created_at, g.updated_at
             FROM session_goals g JOIN sessions s ON s.id=g.session_id WHERE s.workspace_id=?
            ORDER BY g.updated_at DESC`
        )
        .all(workspaceId)
    }
    return db
      .prepare(
        `SELECT g.session_id, g.goal_id, g.objective, g.status, g.token_budget, g.tokens_used,
                g.time_used_seconds, g.created_at, g.updated_at
           FROM session_goals g JOIN sessions s ON s.id=g.session_id WHERE s.workspace_id=?
          ORDER BY g.updated_at DESC, g.session_id DESC LIMIT ? OFFSET ?`
      )
      .all(workspaceId, page(args.limit), offset(args.offset))
  }
  if (method === 'goal-get')
    return goal(text(args.sessionId, 'SESSION'), text(args.workspaceId, 'WORKSPACE'))
  if (method === 'goal-events-list') {
    const sessionId = text(args.sessionId, 'SESSION')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!session(sessionId, workspaceId)) return []
    const goalId = args.goalId == null || args.goalId === '' ? null : text(args.goalId, 'GOAL')
    const requestedLimit = args.limit ?? 40
    if (!Number.isSafeInteger(requestedLimit)) throw new Error('INVALID_BUSINESS_GOAL_EVENT_LIMIT')
    const limit = Math.max(1, Math.min(100, requestedLimit))
    return db
      .prepare(
        `SELECT id, session_id, goal_id, event_type, message, metadata_json, created_at
           FROM session_goal_events WHERE session_id=? AND (? IS NULL OR goal_id=?)
           ORDER BY created_at DESC LIMIT ?`
      )
      .all(sessionId, goalId, goalId, limit)
  }
  if (method === 'memory-roots-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return db
      .prepare(
        `SELECT id,scope,project_id,working_folder,ssh_connection_id,root_path,
      transport,owner_key,created_at,updated_at,workspace_id FROM memory_roots
      WHERE workspace_id=? ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`
      )
      .all(workspaceId, page(args.limit), offset(args.offset))
  }
  if (method === 'memory-root-get') {
    return (
      db
        .prepare(
          `SELECT id,scope,project_id,working_folder,ssh_connection_id,root_path,
      transport,owner_key,created_at,updated_at,workspace_id FROM memory_roots
      WHERE id=? AND workspace_id=?`
        )
        .get(text(args.id, 'MEMORY_ROOT'), text(args.workspaceId, 'WORKSPACE')) ?? null
    )
  }
  if (method === 'memory-root-ensure') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const scope = text(args.scope, 'MEMORY_SCOPE')
    if (scope !== 'global' && scope !== 'project') throw new Error('INVALID_BUSINESS_MEMORY_SCOPE')
    const transport = text(args.transport, 'MEMORY_TRANSPORT')
    if (transport !== 'local' && transport !== 'ssh')
      throw new Error('INVALID_BUSINESS_MEMORY_TRANSPORT')
    const rootPath = text(args.rootPath, 'MEMORY_ROOT_PATH')
    const projectId = nullableText(args.projectId, 'PROJECT')
    const workingFolder = nullableText(args.workingFolder, 'WORKING_FOLDER')
    const sshConnectionId = nullableText(args.sshConnectionId, 'SSH')
    if (transport === 'ssh' && !sshConnectionId)
      throw new Error('BUSINESS_MEMORY_SSH_CONNECTION_REQUIRED')
    const keyParts = [
      scope,
      transport,
      projectId ?? '',
      sshConnectionId ?? '',
      memoryOwnerPath(workingFolder, sshConnectionId),
      memoryOwnerPath(rootPath, sshConnectionId)
    ]
    const ownerKey = keyParts.join('::')
    const scopedOwnerKey =
      workspaceId === 'local-personal'
        ? ownerKey
        : `${workspaceId.length}:${workspaceId}::${ownerKey}`
    const now = Date.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      if (
        projectId &&
        !db
          .prepare('SELECT id FROM projects WHERE id=? AND workspace_id=?')
          .get(projectId, workspaceId)
      )
        throw new Error('BUSINESS_MEMORY_PROJECT_NOT_FOUND')
      const existing = db
        .prepare('SELECT id FROM memory_roots WHERE owner_key=? AND workspace_id=?')
        .get(scopedOwnerKey, workspaceId)
      const id = existing?.id ?? `oc_${randomUUID().replaceAll('-', '')}`
      if (existing) {
        db.prepare(
          `UPDATE memory_roots SET project_id=?,working_folder=?,ssh_connection_id=?,
          root_path=?,transport=?,updated_at=? WHERE id=? AND workspace_id=?`
        ).run(projectId, workingFolder, sshConnectionId, rootPath, transport, now, id, workspaceId)
      } else {
        db.prepare(
          `INSERT INTO memory_roots
          (id,scope,project_id,working_folder,ssh_connection_id,root_path,transport,
           owner_key,created_at,updated_at,workspace_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          id,
          scope,
          projectId,
          workingFolder,
          sshConnectionId,
          rootPath,
          transport,
          scopedOwnerKey,
          now,
          now,
          workspaceId
        )
      }
      const root = memoryRootInWorkspace(id, workspaceId)
      db.exec('COMMIT')
      return root
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'memory-stage1-list') {
    const rootId = text(args.rootId, 'MEMORY_ROOT')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return db
      .prepare(
        `SELECT o.id,o.memory_root_id,o.scope,o.source_session_id,
      o.source_updated_at,o.raw_memory,o.rollout_summary,o.rollout_slug,o.fingerprint,
      o.status,o.usage_count,o.last_usage_at,o.created_at,o.updated_at
      FROM memory_stage1_outputs o JOIN memory_roots r ON r.id=o.memory_root_id
      WHERE o.memory_root_id=? AND r.workspace_id=? AND o.status='active'
      ORDER BY o.created_at DESC,o.id DESC LIMIT ? OFFSET ?`
      )
      .all(rootId, workspaceId, page(args.limit), offset(args.offset))
  }
  if (method === 'memory-stage1-get') {
    return (
      db
        .prepare(
          `SELECT o.id,o.memory_root_id,o.scope,o.source_session_id,
      o.source_updated_at,o.raw_memory,o.rollout_summary,o.rollout_slug,o.fingerprint,
      o.status,o.usage_count,o.last_usage_at,o.created_at,o.updated_at
      FROM memory_stage1_outputs o JOIN memory_roots r ON r.id=o.memory_root_id
      WHERE o.id=? AND r.workspace_id=?`
        )
        .get(text(args.id, 'MEMORY_STAGE1'), text(args.workspaceId, 'WORKSPACE')) ?? null
    )
  }
  if (method === 'memory-stage1-add') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const rootId = text(args.memoryRootId, 'MEMORY_ROOT')
    const root = memoryRootInWorkspace(rootId, workspaceId)
    if (!root) throw new Error('BUSINESS_MEMORY_ROOT_NOT_FOUND')
    const scope = text(args.scope, 'MEMORY_SCOPE')
    if (scope !== root.scope) throw new Error('BUSINESS_MEMORY_SCOPE_MISMATCH')
    const sourceSessionId = text(args.sourceSessionId, 'MEMORY_SOURCE_SESSION')
    assertMemorySourceSession(sourceSessionId, workspaceId)
    const fingerprint = text(args.fingerprint, 'MEMORY_FINGERPRINT')
    const status = args.status ?? 'active'
    if (status !== 'active' && status !== 'superseded' && status !== 'filtered')
      throw new Error('INVALID_BUSINESS_MEMORY_STAGE1_STATUS')
    const now = Date.now()
    db.prepare(
      `INSERT INTO memory_stage1_outputs
      (id,memory_root_id,scope,source_session_id,source_updated_at,raw_memory,
       rollout_summary,rollout_slug,fingerprint,status,usage_count,last_usage_at,
       created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,NULL,?,?)
      ON CONFLICT(memory_root_id,source_session_id,fingerprint) DO UPDATE SET
       raw_memory=excluded.raw_memory,rollout_summary=excluded.rollout_summary,
       rollout_slug=excluded.rollout_slug,status=excluded.status,
       source_updated_at=excluded.source_updated_at,updated_at=excluded.updated_at`
    ).run(
      `oc_${randomUUID().replaceAll('-', '')}`,
      rootId,
      scope,
      sourceSessionId,
      nullableInteger(args.sourceUpdatedAt, 'MEMORY_SOURCE_UPDATED_AT'),
      memoryContent(args.rawMemory, 'MEMORY_RAW'),
      memoryContent(args.rolloutSummary, 'MEMORY_SUMMARY'),
      text(args.rolloutSlug, 'MEMORY_SLUG'),
      fingerprint,
      status,
      now,
      now
    )
    return db
      .prepare(
        `SELECT * FROM memory_stage1_outputs
      WHERE memory_root_id=? AND source_session_id=? AND fingerprint=?`
      )
      .get(rootId, sourceSessionId, fingerprint)
  }
  if (method === 'memory-root-clear') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const rootId = text(args.memoryRootId, 'MEMORY_ROOT')
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!memoryRootInWorkspace(rootId, workspaceId))
        throw new Error('BUSINESS_MEMORY_ROOT_NOT_FOUND')
      const deletedStage1Outputs = db
        .prepare('DELETE FROM memory_stage1_outputs WHERE memory_root_id=?')
        .run(rootId).changes
      const deletedJobs =
        args.includeJobs === true
          ? db
              .prepare('DELETE FROM memory_jobs WHERE memory_root_id=? AND workspace_id=?')
              .run(rootId, workspaceId).changes
          : 0
      db.exec('COMMIT')
      return { deletedStage1Outputs, deletedJobs }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'memory-jobs-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return db
      .prepare(
        `SELECT j.id,j.kind,j.status,j.memory_root_id,j.source_session_id,
      j.lease_owner,j.lease_expires_at,j.attempts,j.error,j.started_at,j.finished_at,
      j.created_at,j.updated_at,j.workspace_id FROM memory_jobs j
      WHERE j.workspace_id=? AND (j.memory_root_id IS NULL OR EXISTS
        (SELECT 1 FROM memory_roots r WHERE r.id=j.memory_root_id AND r.workspace_id=?))
      ORDER BY j.updated_at DESC,j.id DESC LIMIT ? OFFSET ?`
      )
      .all(workspaceId, workspaceId, page(args.limit), offset(args.offset))
  }
  if (method === 'memory-job-get') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return (
      db
        .prepare(
          `SELECT j.id,j.kind,j.status,j.memory_root_id,j.source_session_id,
      j.lease_owner,j.lease_expires_at,j.attempts,j.error,j.started_at,j.finished_at,
      j.created_at,j.updated_at,j.workspace_id FROM memory_jobs j
      WHERE j.id=? AND j.workspace_id=? AND (j.memory_root_id IS NULL OR EXISTS
        (SELECT 1 FROM memory_roots r WHERE r.id=j.memory_root_id AND r.workspace_id=?))`
        )
        .get(text(args.id, 'MEMORY_JOB'), workspaceId, workspaceId) ?? null
    )
  }
  if (method === 'memory-job-create') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const kind = text(args.kind, 'MEMORY_JOB_KIND')
    if (!['stage1', 'phase2', 'daily_rollup'].includes(kind))
      throw new Error('INVALID_BUSINESS_MEMORY_JOB_KIND')
    const status = text(args.status, 'MEMORY_JOB_STATUS')
    if (
      !['pending', 'running', 'succeeded', 'succeeded_no_output', 'skipped', 'failed'].includes(
        status
      )
    )
      throw new Error('INVALID_BUSINESS_MEMORY_JOB_STATUS')
    const rootId = nullableText(args.memoryRootId, 'MEMORY_ROOT')
    if (rootId && !memoryRootInWorkspace(rootId, workspaceId))
      throw new Error('BUSINESS_MEMORY_ROOT_NOT_FOUND')
    const sourceSessionId = nullableText(args.sourceSessionId, 'MEMORY_SOURCE_SESSION')
    assertMemorySourceSession(sourceSessionId, workspaceId)
    const leaseOwner = nullableText(args.leaseOwner, 'MEMORY_LEASE_OWNER')
    const now = Date.now()
    const id = `oc_${randomUUID().replaceAll('-', '')}`
    db.prepare(
      `INSERT INTO memory_jobs
      (id,kind,status,memory_root_id,source_session_id,lease_owner,lease_expires_at,
       attempts,error,started_at,finished_at,created_at,updated_at,workspace_id)
      VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,?,?)`
    ).run(
      id,
      kind,
      status,
      rootId,
      sourceSessionId,
      leaseOwner,
      leaseOwner ? now + 3_600_000 : null,
      status === 'running' ? 1 : 0,
      status === 'running' ? now : null,
      null,
      now,
      now,
      workspaceId
    )
    return db
      .prepare('SELECT * FROM memory_jobs WHERE id=? AND workspace_id=?')
      .get(id, workspaceId)
  }
  if (method === 'memory-job-finish') {
    const id = text(args.id, 'MEMORY_JOB')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const status = text(args.status, 'MEMORY_JOB_STATUS')
    if (!['succeeded', 'succeeded_no_output', 'skipped', 'failed'].includes(status))
      throw new Error('INVALID_BUSINESS_MEMORY_JOB_STATUS')
    const now = Date.now()
    const changed = db
      .prepare(
        `UPDATE memory_jobs SET status=?,error=?,finished_at=?,
      updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND workspace_id=?
      AND status IN ('pending','running') AND (memory_root_id IS NULL OR EXISTS
        (SELECT 1 FROM memory_roots r WHERE r.id=memory_jobs.memory_root_id AND r.workspace_id=?))`
      )
      .run(
        status,
        nullableText(args.error, 'MEMORY_JOB_ERROR'),
        now,
        now,
        id,
        workspaceId,
        workspaceId
      ).changes
    if (!changed) return null
    return db
      .prepare('SELECT * FROM memory_jobs WHERE id=? AND workspace_id=?')
      .get(id, workspaceId)
  }
  if (method === 'memory-entry-record') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const rootId = nullableText(args.memoryRootId, 'MEMORY_ROOT')
    const jobId = nullableText(args.jobId, 'MEMORY_JOB')
    const projectId = nullableText(args.projectId, 'PROJECT')
    const sourceSessionId = nullableText(args.sourceSessionId, 'MEMORY_SOURCE_SESSION')
    db.exec('BEGIN IMMEDIATE')
    try {
      const root = rootId ? memoryRootInWorkspace(rootId, workspaceId) : null
      if (rootId && !root) throw new Error('BUSINESS_MEMORY_ROOT_NOT_FOUND')
      if (root && args.rootScope && args.rootScope !== root.scope)
        throw new Error('BUSINESS_MEMORY_SCOPE_MISMATCH')
      const job = jobId
        ? db
            .prepare('SELECT id,memory_root_id FROM memory_jobs WHERE id=? AND workspace_id=?')
            .get(jobId, workspaceId)
        : null
      if (jobId && !job) throw new Error('BUSINESS_MEMORY_JOB_NOT_FOUND')
      if (rootId && job?.memory_root_id && job.memory_root_id !== rootId)
        throw new Error('BUSINESS_MEMORY_JOB_ROOT_MISMATCH')
      if (
        projectId &&
        !db
          .prepare('SELECT id FROM projects WHERE id=? AND workspace_id=?')
          .get(projectId, workspaceId)
      )
        throw new Error('BUSINESS_MEMORY_PROJECT_NOT_FOUND')
      assertMemorySourceSession(sourceSessionId, workspaceId)
      const confidence = args.confidence ?? 0
      if (typeof confidence !== 'number' || !Number.isFinite(confidence))
        throw new Error('INVALID_BUSINESS_MEMORY_CONFIDENCE')
      const evidenceJson = optionalMemoryContent(args.evidenceJson, 'MEMORY_EVIDENCE_JSON')
      if (evidenceJson !== null) {
        try {
          JSON.parse(evidenceJson)
        } catch {
          throw new Error('INVALID_BUSINESS_MEMORY_EVIDENCE_JSON')
        }
      }
      const id = `oc_${randomUUID().replaceAll('-', '')}`
      const now = Date.now()
      const values = [
        id,
        workspaceId,
        text(args.scope, 'MEMORY_ENTRY_SCOPE'),
        nullableText(args.rootScope, 'MEMORY_ROOT_SCOPE'),
        rootId,
        jobId,
        projectId,
        text(args.target, 'MEMORY_TARGET'),
        text(args.kind, 'MEMORY_KIND'),
        memoryContent(args.content, 'MEMORY_CONTENT'),
        Math.min(1, Math.max(0, confidence)),
        sourceSessionId,
        nullableText(args.targetPath, 'MEMORY_TARGET_PATH'),
        text(args.status, 'MEMORY_ENTRY_STATUS'),
        nullableText(args.filterReason, 'MEMORY_FILTER_REASON'),
        text(args.fingerprint, 'MEMORY_FINGERPRINT'),
        evidenceJson,
        nullableInteger(args.writtenAt, 'MEMORY_WRITTEN_AT'),
        optionalMemoryContent(args.error, 'MEMORY_ERROR'),
        optionalMemoryContent(args.beforeContent, 'MEMORY_BEFORE_CONTENT'),
        optionalMemoryContent(args.afterContent, 'MEMORY_AFTER_CONTENT'),
        optionalMemoryContent(args.appendedText, 'MEMORY_APPENDED_TEXT'),
        nullableText(args.sshConnectionId, 'SSH'),
        now,
        now
      ]
      db.prepare(
        `INSERT INTO memory_automation_entries
        (id,workspace_id,scope,root_scope,memory_root_id,job_id,project_id,target,kind,
         content,confidence,source_session_id,target_path,status,filter_reason,fingerprint,
         evidence_json,written_at,error,before_content,after_content,appended_text,
         ssh_connection_id,created_at,updated_at)
        VALUES(${values.map(() => '?').join(',')})`
      ).run(...values)
      const entry = db
        .prepare('SELECT * FROM memory_automation_entries WHERE id=? AND workspace_id=?')
        .get(id, workspaceId)
      db.exec('COMMIT')
      return entry
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'memory-entry-undo') {
    const id = text(args.id, 'MEMORY_ENTRY')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const status = text(args.status, 'MEMORY_ENTRY_STATUS')
    if (status !== 'undone' && status !== 'error')
      throw new Error('INVALID_BUSINESS_MEMORY_ENTRY_STATUS')
    const now = Date.now()
    const changed = db
      .prepare(
        `UPDATE memory_automation_entries SET status=?,error=?,
      updated_at=?,undone_at=CASE WHEN ?='undone' THEN ? ELSE undone_at END
      WHERE id=? AND workspace_id=? AND status<>'undone'`
      )
      .run(
        status,
        optionalMemoryContent(args.error, 'MEMORY_ERROR'),
        now,
        status,
        now,
        id,
        workspaceId
      ).changes
    if (!changed) return null
    return db
      .prepare('SELECT * FROM memory_automation_entries WHERE id=? AND workspace_id=?')
      .get(id, workspaceId)
  }
  if (method === 'memory-entries-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const rows = db
      .prepare(
        `SELECT e.* FROM memory_automation_entries e WHERE e.workspace_id=?
      AND (e.memory_root_id IS NULL OR EXISTS
        (SELECT 1 FROM memory_roots r WHERE r.id=e.memory_root_id AND r.workspace_id=?))
      ORDER BY e.created_at DESC,e.id DESC LIMIT ? OFFSET ?`
      )
      .all(workspaceId, workspaceId, page(args.limit), offset(args.offset))
    return args.includeContentSnapshots === true
      ? rows
      : rows.map((row) => ({
          ...row,
          before_content: null,
          after_content: null,
          appended_text: null
        }))
  }
  if (method === 'memory-entry-get') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    return (
      db
        .prepare(
          `SELECT e.* FROM memory_automation_entries e WHERE e.id=?
      AND e.workspace_id=? AND (e.memory_root_id IS NULL OR EXISTS
        (SELECT 1 FROM memory_roots r WHERE r.id=e.memory_root_id AND r.workspace_id=?))`
        )
        .get(text(args.id, 'MEMORY_ENTRY'), workspaceId, workspaceId) ?? null
    )
  }
  if (method === 'memory-rollup-mark') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    db.prepare(
      `INSERT OR REPLACE INTO memory_automation_rollups_v2
      (workspace_id,scope,target,target_path,source_date,content_hash,processed_at)
      VALUES(?,?,?,?,?,?,?)`
    ).run(
      workspaceId,
      text(args.scope, 'MEMORY_ENTRY_SCOPE'),
      text(args.target, 'MEMORY_TARGET'),
      text(args.targetPath, 'MEMORY_TARGET_PATH'),
      text(args.sourceDate, 'MEMORY_SOURCE_DATE'),
      text(args.contentHash, 'MEMORY_CONTENT_HASH'),
      Date.now()
    )
    return true
  }
  if (method === 'memory-rollups-list') {
    return db
      .prepare(
        `SELECT workspace_id,scope,target,target_path,source_date,content_hash,
      processed_at FROM memory_automation_rollups_v2 WHERE workspace_id=?
      ORDER BY processed_at DESC,target_path DESC LIMIT ? OFFSET ?`
      )
      .all(text(args.workspaceId, 'WORKSPACE'), page(args.limit), offset(args.offset))
  }
  if (method === 'memory-citations-list') {
    return db
      .prepare(
        `SELECT c.id,c.memory_root_id,c.scope,c.source_session_id,c.path,c.line,
      c.citation_json,c.created_at FROM memory_citation_usage c
      JOIN memory_roots r ON r.id=c.memory_root_id
      WHERE c.memory_root_id=? AND r.workspace_id=?
      ORDER BY c.created_at DESC,c.id DESC LIMIT ? OFFSET ?`
      )
      .all(
        text(args.rootId, 'MEMORY_ROOT'),
        text(args.workspaceId, 'WORKSPACE'),
        page(args.limit),
        offset(args.offset)
      )
  }
  if (method === 'memory-citation-record') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const rootId = text(args.memoryRootId, 'MEMORY_ROOT')
    const root = memoryRootInWorkspace(rootId, workspaceId)
    if (!root) throw new Error('BUSINESS_MEMORY_ROOT_NOT_FOUND')
    const scope = text(args.scope, 'MEMORY_SCOPE')
    if (scope !== root.scope) throw new Error('BUSINESS_MEMORY_SCOPE_MISMATCH')
    const sourceSessionId = nullableText(args.sourceSessionId, 'MEMORY_SOURCE_SESSION')
    assertMemorySourceSession(sourceSessionId, workspaceId)
    const now = Date.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `INSERT INTO memory_citation_usage
        (id,memory_root_id,scope,source_session_id,path,line,citation_json,created_at)
        VALUES(?,?,?,?,?,?,?,?)`
      ).run(
        `oc_${randomUUID().replaceAll('-', '')}`,
        rootId,
        scope,
        sourceSessionId,
        text(args.path, 'MEMORY_CITATION_PATH'),
        nullableInteger(args.line, 'MEMORY_CITATION_LINE'),
        optionalMemoryContent(args.citationJson, 'MEMORY_CITATION_JSON'),
        now
      )
      const changed = db
        .prepare(
          `UPDATE memory_stage1_outputs SET usage_count=usage_count+1,
        last_usage_at=?,updated_at=? WHERE memory_root_id=?`
        )
        .run(now, now, rootId).changes
      db.exec('COMMIT')
      return changed
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'cron-jobs-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const includeDeleted = args.includeDeleted === true
    const hasPage = args.limit != null
    const rowOffset = offset(args.offset)
    const pagination = hasPage ? 'LIMIT ? OFFSET ?' : rowOffset > 0 ? 'LIMIT -1 OFFSET ?' : ''
    return db
      .prepare(
        `SELECT ${CRON_JOB_COLUMNS}
           FROM cron_jobs WHERE workspace_id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
          ORDER BY created_at DESC, id DESC ${pagination}`
      )
      .all(
        workspaceId,
        ...(hasPage ? [page(args.limit), rowOffset] : rowOffset > 0 ? [rowOffset] : [])
      )
  }
  if (method === 'cron-job-get') {
    return (
      db
        .prepare(
          `SELECT ${CRON_JOB_COLUMNS}
           FROM cron_jobs WHERE id=? AND workspace_id=?`
        )
        .get(text(args.id, 'CRON_JOB'), text(args.workspaceId, 'WORKSPACE')) ?? null
    )
  }
  if (method === 'cron-recover') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const now = timestamp(args.now, 'CRON_RECOVERY_TIME')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `
        UPDATE cron_run_deliveries
        SET status='unknown',finished_at=?,error_code='PROCESS_INTERRUPTED'
        WHERE status='pending' AND run_id IN (
          SELECT id FROM cron_runs
          WHERE job_id IN (SELECT id FROM cron_jobs WHERE workspace_id=?)
        )
      `
      ).run(now, workspaceId)
      const abortedRuns = db
        .prepare(
          `UPDATE cron_runs
            SET finished_at=?,status='aborted',
                error=COALESCE(error,'Cron run interrupted before completion')
          WHERE status='running' AND finished_at IS NULL
            AND job_id IN (SELECT id FROM cron_jobs WHERE workspace_id=?)`
        )
        .run(now, workspaceId).changes
      const expiredJobs = db
        .prepare(
          `UPDATE cron_jobs SET enabled=0,deleted_at=COALESCE(deleted_at,?),updated_at=?
          WHERE workspace_id=? AND schedule_kind='at' AND schedule_at<?
            AND delete_after_run=1 AND deleted_at IS NULL`
        )
        .run(now, now, workspaceId, now).changes
      const jobs = db
        .prepare(
          `SELECT ${CRON_JOB_COLUMNS} FROM cron_jobs
          WHERE workspace_id=? AND enabled=1 AND deleted_at IS NULL
          ORDER BY created_at DESC,id DESC`
        )
        .all(workspaceId)
      db.exec('COMMIT')
      return { jobs, abortedRuns, expiredJobs }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'cron-runs-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const values = [workspaceId]
    const boundary = (key, inclusive) => {
      if (!key) return ''
      values.push(key.at, key.at, key.id)
      return `AND (r.started_at < ? OR (r.started_at=? AND r.id ${inclusive ? '<=' : '<'} ?))`
    }
    const anchor = boundary(args.anchor, true)
    const after = boundary(args.after, false)
    return db
      .prepare(
        `SELECT r.id,r.job_id,r.started_at,r.finished_at,r.status,r.tool_call_count,r.output_summary,
                r.error,r.scheduled_for,r.job_name_snapshot,r.prompt_snapshot,
                r.source_session_id_snapshot,r.source_session_title_snapshot,
                r.source_project_id_snapshot,r.source_project_name_snapshot,
                r.source_provider_id_snapshot,r.model_snapshot,r.model_source_snapshot,
                r.working_folder_snapshot,r.delivery_mode_snapshot,r.delivery_target_snapshot,r.run_kind,
                (SELECT CASE
                  WHEN EXISTS (SELECT 1 FROM cron_run_deliveries d WHERE d.run_id=r.id AND d.status='failed' AND NOT EXISTS (SELECT 1 FROM cron_run_deliveries child WHERE child.retry_of_id=d.id)) THEN 'failed'
                  WHEN EXISTS (SELECT 1 FROM cron_run_deliveries d WHERE d.run_id=r.id AND d.status='unknown' AND NOT EXISTS (SELECT 1 FROM cron_run_deliveries child WHERE child.retry_of_id=d.id)) THEN 'unknown'
                  WHEN EXISTS (SELECT 1 FROM cron_run_deliveries d WHERE d.run_id=r.id AND d.status='pending' AND NOT EXISTS (SELECT 1 FROM cron_run_deliveries child WHERE child.retry_of_id=d.id)) THEN 'pending'
                  WHEN EXISTS (SELECT 1 FROM cron_run_deliveries d WHERE d.run_id=r.id AND d.status='sent' AND NOT EXISTS (SELECT 1 FROM cron_run_deliveries child WHERE child.retry_of_id=d.id)) THEN 'sent'
                  ELSE NULL END FROM cron_run_deliveries d WHERE d.run_id=r.id) AS delivery_status
           FROM cron_runs r JOIN cron_jobs j ON j.id=r.job_id WHERE j.workspace_id=?
          ${args.attentionOnly ? "AND (r.status IN ('error','failed') OR EXISTS (SELECT 1 FROM cron_run_deliveries d WHERE d.run_id=r.id AND d.status IN ('failed','unknown','pending') AND NOT EXISTS (SELECT 1 FROM cron_run_deliveries child WHERE child.retry_of_id=d.id)))" : ''}
          ${anchor} ${after}
          ORDER BY r.started_at DESC,r.id DESC LIMIT ? OFFSET ?`
      )
      .all(...values, page(args.limit), offset(args.offset))
  }
  if (method === 'cron-run-detail') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const runId = text(args.runId, 'CRON_RUN')
    const run = db
      .prepare(
        `SELECT r.id,r.job_id,r.started_at,r.finished_at,r.status,r.tool_call_count,r.output_summary,
                r.error,r.scheduled_for,r.job_name_snapshot,r.prompt_snapshot,
                r.source_session_id_snapshot,r.source_session_title_snapshot,
                r.source_project_id_snapshot,r.source_project_name_snapshot,
                r.source_provider_id_snapshot,r.model_snapshot,r.model_source_snapshot,
                r.working_folder_snapshot,r.delivery_mode_snapshot,r.delivery_target_snapshot,r.run_kind,
                (SELECT CASE
                  WHEN EXISTS (SELECT 1 FROM cron_run_deliveries d WHERE d.run_id=r.id AND d.status='failed' AND NOT EXISTS (SELECT 1 FROM cron_run_deliveries child WHERE child.retry_of_id=d.id)) THEN 'failed'
                  WHEN EXISTS (SELECT 1 FROM cron_run_deliveries d WHERE d.run_id=r.id AND d.status='unknown' AND NOT EXISTS (SELECT 1 FROM cron_run_deliveries child WHERE child.retry_of_id=d.id)) THEN 'unknown'
                  WHEN EXISTS (SELECT 1 FROM cron_run_deliveries d WHERE d.run_id=r.id AND d.status='pending' AND NOT EXISTS (SELECT 1 FROM cron_run_deliveries child WHERE child.retry_of_id=d.id)) THEN 'pending'
                  WHEN EXISTS (SELECT 1 FROM cron_run_deliveries d WHERE d.run_id=r.id AND d.status='sent' AND NOT EXISTS (SELECT 1 FROM cron_run_deliveries child WHERE child.retry_of_id=d.id)) THEN 'sent'
                  ELSE NULL END FROM cron_run_deliveries d WHERE d.run_id=r.id) AS delivery_status
           FROM cron_runs r JOIN cron_jobs j ON j.id=r.job_id
          WHERE r.id=? AND j.workspace_id=?`
      )
      .get(runId, workspaceId)
    if (!run) return null
    return {
      run,
      job:
        db
          .prepare(`SELECT ${CRON_JOB_COLUMNS} FROM cron_jobs WHERE id=? AND workspace_id=?`)
          .get(run.job_id, workspaceId) ?? null,
      messages: db
        .prepare(
          `SELECT id,role,content,usage,message_source,created_at
             FROM cron_run_messages WHERE run_id=? ORDER BY sort_order ASC`
        )
        .all(runId),
      logs: db
        .prepare(
          `SELECT id,timestamp,type,content
             FROM cron_run_logs WHERE run_id=? ORDER BY sort_order ASC`
        )
        .all(runId),
      deliveries: db
        .prepare(
          `
          SELECT id,run_id,tool_call_id,kind,status,started_at,finished_at,error_code
          FROM cron_run_deliveries WHERE run_id=? ORDER BY started_at,id
        `
        )
        .all(runId)
    }
  }
  if (method === 'cron-job-create') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = nullableText(args.sessionId, 'CRON_SESSION')
    const sourceProjectId = nullableText(args.sourceProjectId, 'CRON_PROJECT')
    cronScope(sessionId, sourceProjectId, workspaceId)
    const [scheduleKind, scheduleAt, scheduleEvery, scheduleExpr] = cronSchedule(args)
    const createdAt = timestamp(args.createdAt, 'CREATED_AT')
    const row = {
      id: text(args.id, 'CRON_JOB'),
      workspace_id: workspaceId,
      name: text(args.name, 'CRON_NAME'),
      schedule_kind: scheduleKind,
      schedule_at: scheduleAt,
      schedule_every: scheduleEvery,
      schedule_expr: scheduleExpr,
      schedule_tz: nullableText(args.scheduleTz, 'CRON_SCHEDULE_TZ') ?? 'UTC',
      prompt: cronPrompt(args.prompt),
      agent_id: nullableText(args.agentId, 'CRON_AGENT'),
      model: nullableText(args.model, 'CRON_MODEL'),
      model_source: cronModelSource(args.modelSource, workspaceId),
      working_folder: nullableText(args.workingFolder, 'CRON_FOLDER'),
      ssh_connection_id: nullableText(args.sshConnectionId, 'CRON_SSH'),
      session_id: sessionId,
      source_session_title: nullableText(args.sourceSessionTitle, 'CRON_SESSION_TITLE'),
      source_project_id: sourceProjectId,
      source_project_name: nullableText(args.sourceProjectName, 'CRON_PROJECT_NAME'),
      source_provider_id: cronSourceProvider(args.sourceProviderId, workspaceId),
      delivery_mode: cronDeliveryMode(args.deliveryMode),
      delivery_target: nullableText(args.deliveryTarget, 'CRON_DELIVERY_TARGET'),
      plugin_id: nullableText(args.pluginId, 'CRON_PLUGIN'),
      plugin_chat_id: nullableText(args.pluginChatId, 'CRON_PLUGIN_CHAT'),
      enabled: args.enabled === undefined ? 1 : bool(args.enabled, 'CRON_ENABLED'),
      delete_after_run:
        args.deleteAfterRun === undefined ? 0 : bool(args.deleteAfterRun, 'CRON_DELETE_AFTER_RUN'),
      max_iterations: timestamp(args.maxIterations ?? 15, 'CRON_MAX_ITERATIONS'),
      deleted_at: null,
      last_fired_at: null,
      fire_count: 0,
      created_at: createdAt,
      updated_at: timestamp(args.updatedAt ?? createdAt, 'UPDATED_AT')
    }
    const columns = Object.keys(row)
    db.prepare(
      `INSERT INTO cron_jobs (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    ).run(...Object.values(row))
    return true
  }
  if (method === 'cron-job-update') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'CRON_JOB')
    const existing = db
      .prepare('SELECT id FROM cron_jobs WHERE id=? AND workspace_id=? AND deleted_at IS NULL')
      .get(id, workspaceId)
    if (!existing) throw new Error('BUSINESS_CRON_JOB_NOT_FOUND')
    const patch = args.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw new Error('INVALID_BUSINESS_CRON_PATCH')
    const changes = {}
    const fields = [
      ['name', 'name', (value) => text(value, 'CRON_NAME')],
      ['prompt', 'prompt', cronPrompt],
      ['agentId', 'agent_id', (value) => nullableText(value, 'CRON_AGENT')],
      ['model', 'model', (value) => nullableText(value, 'CRON_MODEL')],
      ['modelSource', 'model_source', (value) => cronModelSource(value, workspaceId)],
      ['workingFolder', 'working_folder', (value) => nullableText(value, 'CRON_FOLDER')],
      ['sshConnectionId', 'ssh_connection_id', (value) => nullableText(value, 'CRON_SSH')],
      ['sessionId', 'session_id', (value) => nullableText(value, 'CRON_SESSION')],
      [
        'sourceSessionTitle',
        'source_session_title',
        (value) => nullableText(value, 'CRON_SESSION_TITLE')
      ],
      ['sourceProjectId', 'source_project_id', (value) => nullableText(value, 'CRON_PROJECT')],
      [
        'sourceProjectName',
        'source_project_name',
        (value) => nullableText(value, 'CRON_PROJECT_NAME')
      ],
      ['sourceProviderId', 'source_provider_id', (value) => cronSourceProvider(value, workspaceId)],
      ['deliveryMode', 'delivery_mode', cronDeliveryMode],
      ['deliveryTarget', 'delivery_target', (value) => nullableText(value, 'CRON_DELIVERY_TARGET')],
      ['pluginId', 'plugin_id', (value) => nullableText(value, 'CRON_PLUGIN')],
      ['pluginChatId', 'plugin_chat_id', (value) => nullableText(value, 'CRON_PLUGIN_CHAT')],
      ['enabled', 'enabled', (value) => bool(value, 'CRON_ENABLED')],
      ['deleteAfterRun', 'delete_after_run', (value) => bool(value, 'CRON_DELETE_AFTER_RUN')],
      ['maxIterations', 'max_iterations', (value) => timestamp(value, 'CRON_MAX_ITERATIONS')]
    ]
    for (const [key, column, normalize] of fields) {
      if (patch[key] !== undefined) changes[column] = normalize(patch[key])
    }
    if (patch.scheduleKind !== undefined) {
      const [kind, at, every, expr] = cronSchedule(patch)
      Object.assign(changes, {
        schedule_kind: kind,
        schedule_at: at,
        schedule_every: every,
        schedule_expr: expr
      })
    }
    if (patch.scheduleTz !== undefined)
      changes.schedule_tz = nullableText(patch.scheduleTz, 'CRON_SCHEDULE_TZ') ?? 'UTC'
    if (!Object.keys(changes).length) throw new Error('BUSINESS_UPDATE_EMPTY')
    cronScope(
      changes.session_id === undefined ? null : changes.session_id,
      changes.source_project_id === undefined ? null : changes.source_project_id,
      workspaceId
    )
    changes.updated_at = timestamp(args.updatedAt, 'UPDATED_AT')
    const columns = Object.keys(changes)
    const result = db
      .prepare(
        `UPDATE cron_jobs SET ${columns.map((column) => `${column}=?`).join(',')} WHERE id=? AND workspace_id=? AND deleted_at IS NULL`
      )
      .run(...Object.values(changes), id, workspaceId)
    if (!result.changes) throw new Error('BUSINESS_CRON_JOB_NOT_FOUND')
    return true
  }
  if (method === 'cron-job-delete') {
    const result = db
      .prepare('DELETE FROM cron_jobs WHERE id=? AND workspace_id=?')
      .run(text(args.id, 'CRON_JOB'), text(args.workspaceId, 'WORKSPACE'))
    if (!result.changes) throw new Error('BUSINESS_CRON_JOB_NOT_FOUND')
    return true
  }
  if (method === 'cron-job-mark-fired') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'CRON_JOB')
    const firedAt = timestamp(args.firedAt, 'FIRED_AT')
    const updatedAt = timestamp(args.updatedAt ?? firedAt, 'UPDATED_AT')
    const changed = db
      .prepare(
        `UPDATE cron_jobs SET last_fired_at=?,fire_count=fire_count+1,updated_at=?
          WHERE id=? AND workspace_id=? AND enabled=1 AND deleted_at IS NULL`
      )
      .run(firedAt, updatedAt, id, workspaceId)
    if (!changed.changes) throw new Error('BUSINESS_CRON_JOB_NOT_FOUND')
    return true
  }
  if (method === 'cron-job-set-enabled') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const changed = db
      .prepare(
        'UPDATE cron_jobs SET enabled=?,updated_at=? WHERE id=? AND workspace_id=? AND deleted_at IS NULL'
      )
      .run(
        bool(args.enabled, 'CRON_ENABLED'),
        timestamp(args.updatedAt, 'UPDATED_AT'),
        text(args.id, 'CRON_JOB'),
        workspaceId
      )
    if (!changed.changes) throw new Error('BUSINESS_CRON_JOB_NOT_FOUND')
    return true
  }
  if (method === 'cron-job-soft-delete') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const deletedAt = timestamp(args.deletedAt, 'DELETED_AT')
    const changed = db
      .prepare(
        `UPDATE cron_jobs SET enabled=0,deleted_at=?,updated_at=?
          WHERE id=? AND workspace_id=? AND deleted_at IS NULL`
      )
      .run(
        deletedAt,
        timestamp(args.updatedAt ?? deletedAt, 'UPDATED_AT'),
        text(args.id, 'CRON_JOB'),
        workspaceId
      )
    if (!changed.changes) throw new Error('BUSINESS_CRON_JOB_NOT_FOUND')
    return true
  }
  if (method === 'cron-run-create') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const jobId = text(args.jobId, 'CRON_JOB')
    const job = db
      .prepare(
        `SELECT id,name,prompt,session_id,source_session_title,source_project_id,
                       source_project_name,source_provider_id,model,model_source,working_folder,
                       delivery_mode,delivery_target
                  FROM cron_jobs WHERE id=? AND workspace_id=? AND deleted_at IS NULL`
      )
      .get(jobId, workspaceId)
    if (!job) throw new Error('BUSINESS_CRON_JOB_NOT_FOUND')
    const snapshot = (key, column) => (args[key] === undefined ? job[column] : args[key])
    const row = {
      id: text(args.id, 'CRON_RUN'),
      job_id: jobId,
      started_at: timestamp(args.startedAt, 'STARTED_AT'),
      finished_at: null,
      status: 'running',
      tool_call_count: 0,
      output_summary: null,
      error: null,
      scheduled_for: nullableInteger(args.scheduledFor, 'SCHEDULED_FOR'),
      job_name_snapshot: nullableText(snapshot('jobNameSnapshot', 'name'), 'CRON_JOB_NAME'),
      prompt_snapshot: nullableCronText(snapshot('promptSnapshot', 'prompt'), 'CRON_PROMPT'),
      source_session_id_snapshot: nullableText(
        snapshot('sourceSessionIdSnapshot', 'session_id'),
        'CRON_SESSION'
      ),
      source_session_title_snapshot: nullableText(
        snapshot('sourceSessionTitleSnapshot', 'source_session_title'),
        'CRON_SESSION_TITLE'
      ),
      source_project_id_snapshot: nullableText(
        snapshot('sourceProjectIdSnapshot', 'source_project_id'),
        'CRON_PROJECT'
      ),
      source_project_name_snapshot: nullableText(
        snapshot('sourceProjectNameSnapshot', 'source_project_name'),
        'CRON_PROJECT_NAME'
      ),
      source_provider_id_snapshot: cronSourceProvider(
        snapshot('sourceProviderIdSnapshot', 'source_provider_id'),
        workspaceId
      ),
      model_snapshot: nullableText(snapshot('modelSnapshot', 'model'), 'CRON_MODEL'),
      model_source_snapshot: cronModelSource(
        snapshot('modelSourceSnapshot', 'model_source'),
        workspaceId
      ),
      working_folder_snapshot: nullableText(
        snapshot('workingFolderSnapshot', 'working_folder'),
        'CRON_FOLDER'
      ),
      delivery_mode_snapshot: cronDeliveryMode(snapshot('deliveryModeSnapshot', 'delivery_mode')),
      delivery_target_snapshot: nullableText(
        snapshot('deliveryTargetSnapshot', 'delivery_target'),
        'CRON_DELIVERY_TARGET'
      ),
      run_kind: ['scheduled', 'manual', 'trial'].includes(args.runKind) ? args.runKind : 'scheduled'
    }
    cronSnapshotScope(row.source_session_id_snapshot, row.source_project_id_snapshot, workspaceId)
    const columns = Object.keys(row)
    db.prepare(
      `INSERT INTO cron_runs (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    ).run(...Object.values(row))
    return true
  }
  if (method === 'cron-run-start') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const jobId = text(args.jobId, 'CRON_JOB')
    const firedAt = timestamp(args.firedAt, 'FIRED_AT')
    const scheduledFor = nullableInteger(args.scheduledFor, 'SCHEDULED_FOR')
    const runKind = ['scheduled', 'manual', 'trial'].includes(args.runKind)
      ? args.runKind
      : 'scheduled'
    db.exec('BEGIN IMMEDIATE')
    try {
      const job = db
        .prepare(
          `SELECT schedule_kind,fire_count,enabled FROM cron_jobs
          WHERE id=? AND workspace_id=? AND deleted_at IS NULL`
        )
        .get(jobId, workspaceId)
      if (!job || (runKind === 'scheduled' && job.enabled !== 1))
        throw new Error('BUSINESS_CRON_JOB_NOT_FOUND')
      if (runKind === 'scheduled' && job.schedule_kind === 'at' && job.fire_count > 0) {
        db.exec('COMMIT')
        return { started: false, reason: 'already-fired' }
      }
      if (
        db
          .prepare(
            `SELECT id FROM cron_runs WHERE job_id=? AND status='running' AND finished_at IS NULL LIMIT 1`
          )
          .get(jobId)
      ) {
        db.exec('COMMIT')
        return { started: false, reason: 'already-running' }
      }
      if (
        runKind === 'scheduled' &&
        scheduledFor !== null &&
        db
          .prepare('SELECT id FROM cron_runs WHERE job_id=? AND scheduled_for=? LIMIT 1')
          .get(jobId, scheduledFor)
      ) {
        db.exec('COMMIT')
        return { started: false, reason: 'duplicate-schedule' }
      }
      dispatch('cron-run-create', args)
      if (runKind === 'scheduled') {
        db.prepare(
          `UPDATE cron_jobs
          SET last_fired_at=?,fire_count=fire_count+1,updated_at=?
          WHERE id=? AND workspace_id=? AND enabled=1 AND deleted_at IS NULL`
        ).run(firedAt, firedAt, jobId, workspaceId)
      }
      db.exec('COMMIT')
      return { started: true, runId: text(args.id, 'CRON_RUN') }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'cron-run-finish') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const status = text(args.status, 'CRON_STATUS')
    if (!['success', 'error', 'aborted', 'skipped'].includes(status))
      throw new Error('INVALID_BUSINESS_CRON_STATUS')
    const result = db
      .prepare(
        `UPDATE cron_runs SET finished_at=?,status=?,tool_call_count=?,output_summary=?,error=?
       WHERE id=? AND status='running' AND finished_at IS NULL
         AND job_id IN (SELECT id FROM cron_jobs WHERE workspace_id=?)`
      )
      .run(
        timestamp(args.finishedAt, 'FINISHED_AT'),
        status,
        timestamp(args.toolCallCount, 'TOOL_CALL_COUNT'),
        nullableCronText(args.outputSummary, 'CRON_OUTPUT_SUMMARY'),
        nullableCronText(args.error, 'CRON_ERROR'),
        text(args.id, 'CRON_RUN'),
        workspaceId
      )
    if (!result.changes) throw new Error('BUSINESS_CRON_RUN_NOT_FOUND')
    return true
  }
  if (method === 'cron-run-replace-messages') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const runId = text(args.runId, 'CRON_RUN')
    if (!cronRun(runId, workspaceId)) throw new Error('BUSINESS_CRON_RUN_NOT_FOUND')
    if (!Array.isArray(args.messages) || args.messages.length > 10_000)
      throw new Error('INVALID_BUSINESS_CRON_MESSAGES')
    const rows = args.messages.map((message, index) => {
      if (!message || typeof message !== 'object' || Array.isArray(message))
        throw new Error('INVALID_BUSINESS_CRON_MESSAGE')
      return [
        text(message.id, 'CRON_MESSAGE'),
        runId,
        text(message.role, 'CRON_ROLE'),
        cronJson(message.content, 'CRON_CONTENT'),
        message.usage == null ? null : cronJson(message.usage, 'CRON_USAGE'),
        nullableText(message.source, 'CRON_MESSAGE_SOURCE'),
        index,
        timestamp(message.createdAt, 'CREATED_AT')
      ]
    })
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM cron_run_messages WHERE run_id=?').run(runId)
      const insert = db.prepare(`INSERT INTO cron_run_messages
        (id,run_id,role,content,usage,message_source,sort_order,created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
      for (const row of rows) insert.run(...row)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return true
  }
  if (method === 'cron-run-append-log') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const runId = text(args.runId, 'CRON_RUN')
    if (!cronRun(runId, workspaceId)) throw new Error('BUSINESS_CRON_RUN_NOT_FOUND')
    db.exec('BEGIN IMMEDIATE')
    try {
      const next = db
        .prepare(
          'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM cron_run_logs WHERE run_id=?'
        )
        .get(runId).next
      db.prepare(
        `INSERT INTO cron_run_logs (id,run_id,timestamp,type,content,sort_order)
        VALUES (?,?,?,?,?,?)`
      ).run(
        text(args.id, 'CRON_LOG'),
        runId,
        timestamp(args.timestamp, 'CRON_LOG_TIMESTAMP'),
        text(args.type, 'CRON_LOG_TYPE'),
        nullableCronText(args.content, 'CRON_LOG_CONTENT') ?? '',
        next
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return true
  }
  if (method === 'cron-delivery-record') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const runId = text(args.runId, 'CRON_RUN')
    if (!cronRun(runId, workspaceId)) throw new Error('BUSINESS_CRON_RUN_NOT_FOUND')
    const kind = text(args.kind, 'CRON_DELIVERY_KIND')
    const status = text(args.status, 'CRON_DELIVERY_STATUS')
    if (!['desktop', 'channel', 'session'].includes(kind))
      throw new Error('INVALID_CRON_DELIVERY_KIND')
    if (!['pending', 'sent', 'failed', 'unknown'].includes(status))
      throw new Error('INVALID_CRON_DELIVERY_STATUS')
    return (
      db
        .prepare(
          `
      INSERT INTO cron_run_deliveries
        (id,run_id,tool_call_id,kind,status,started_at,finished_at,error_code,
         retry_of_id,attempt_number,plugin_id,chat_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id,tool_call_id) DO UPDATE SET
        status=excluded.status,
        finished_at=excluded.finished_at,
        error_code=excluded.error_code
      WHERE cron_run_deliveries.status='pending'
         OR cron_run_deliveries.status=excluded.status
    `
        )
        .run(
          text(args.id, 'CRON_DELIVERY'),
          runId,
          text(args.toolCallId, 'CRON_TOOL_CALL'),
          kind,
          status,
          timestamp(args.startedAt, 'CRON_DELIVERY_STARTED_AT'),
          nullableInteger(args.finishedAt, 'CRON_DELIVERY_FINISHED_AT'),
          nullableText(args.errorCode, 'CRON_DELIVERY_ERROR'),
          nullableText(args.retryOfId, 'CRON_DELIVERY_RETRY_PARENT'),
          args.attemptNumber === undefined
            ? 1
            : timestamp(args.attemptNumber, 'CRON_DELIVERY_ATTEMPT'),
          nullableText(args.pluginId, 'CRON_DELIVERY_PLUGIN'),
          nullableText(args.chatId, 'CRON_DELIVERY_CHAT')
        ).changes > 0
    )
  }
  if (method === 'cron-session-pending-list') {
    const afterRunId = typeof args.afterRunId === 'string' ? args.afterRunId : ''
    const limit = Math.max(1, Math.min(Number(args.limit) || 500, 500))
    return db
      .prepare(
        `SELECT r.id AS run_id,j.workspace_id,r.delivery_target_snapshot,
                r.source_session_id_snapshot,r.output_summary,r.error
         FROM cron_runs r JOIN cron_jobs j ON j.id=r.job_id
         WHERE r.id > ? AND r.delivery_mode_snapshot='session'
           AND r.run_kind!='trial' AND r.status!='running'
           AND r.started_at >= (
             SELECT applied_at FROM ola_ts_schema_migrations WHERE version=11
           )
           AND NOT EXISTS (
             SELECT 1 FROM cron_run_deliveries d
             WHERE d.run_id=r.id AND d.tool_call_id='session-delivery'
           )
         ORDER BY r.id LIMIT ?`
      )
      .all(afterRunId, limit)
  }
  if (method === 'cron-session-deliver') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const runId = text(args.runId, 'CRON_RUN')
    const targetSessionId =
      typeof args.targetSessionId === 'string' && args.targetSessionId.trim()
        ? text(args.targetSessionId.trim(), 'SESSION')
        : ''
    const content = messageValue(args.content, 'MESSAGE_CONTENT')
    const createdAt = timestamp(args.createdAt, 'CREATED_AT')
    db.exec('BEGIN IMMEDIATE')
    try {
      const run = db
        .prepare(
          `
        SELECT r.id,r.job_id,r.status,r.run_kind,r.delivery_mode_snapshot
        FROM cron_runs r JOIN cron_jobs j ON j.id=r.job_id
        WHERE r.id=? AND j.workspace_id=?
      `
        )
        .get(runId, workspaceId)
      if (!run) throw new Error('BUSINESS_CRON_RUN_NOT_FOUND')
      if (
        run.delivery_mode_snapshot !== 'session' ||
        run.run_kind === 'trial' ||
        run.status === 'running'
      )
        throw new Error('BUSINESS_CRON_SESSION_DELIVERY_NOT_ALLOWED')
      const toolCallId = 'session-delivery'
      const existing = db
        .prepare(
          'SELECT kind,status,error_code FROM cron_run_deliveries WHERE run_id=? AND tool_call_id=?'
        )
        .get(runId, toolCallId)
      if (existing) {
        if (existing.kind !== 'session') throw new Error('BUSINESS_CRON_DELIVERY_KIND_MISMATCH')
        db.exec('COMMIT')
        return { status: existing.status, inserted: false, errorCode: existing.error_code }
      }
      const errorCode = !targetSessionId
        ? 'TARGET_SESSION_UNSPECIFIED'
        : !session(targetSessionId, workspaceId)
          ? 'TARGET_SESSION_NOT_FOUND'
          : null
      const status = errorCode ? 'failed' : 'sent'
      if (!errorCode) {
        const messageId = `cron-session-${runId}`
        assertMessageIdOwner(messageId, targetSessionId)
        const nextOrder = Number(
          db
            .prepare(
              'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM messages WHERE session_id=?'
            )
            .get(targetSessionId).next_order
        )
        const inserted = db
          .prepare(
            `
          INSERT OR IGNORE INTO messages
            (id,session_id,role,content,meta,created_at,usage,sort_order)
          VALUES (?,?,?,?,?,?,?,?)
        `
          )
          .run(
            messageId,
            targetSessionId,
            'assistant',
            JSON.stringify(content),
            JSON.stringify({ source: 'cron', runId, jobId: run.job_id }),
            createdAt,
            null,
            nextOrder
          ).changes
        if (!inserted) throw new Error('BUSINESS_CRON_SESSION_MESSAGE_CONFLICT')
        setSessionMessageCount(targetSessionId, workspaceId)
        db.prepare(
          'UPDATE sessions SET updated_at=MAX(updated_at,?) WHERE id=? AND workspace_id=?'
        ).run(createdAt, targetSessionId, workspaceId)
      }
      db.prepare(
        `
        INSERT INTO cron_run_deliveries
          (id,run_id,tool_call_id,kind,status,started_at,finished_at,error_code,
           retry_of_id,attempt_number,plugin_id,chat_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `
      ).run(
        `delivery-session-${runId}`,
        runId,
        toolCallId,
        'session',
        status,
        createdAt,
        createdAt,
        errorCode,
        null,
        1,
        null,
        null
      )
      db.exec('COMMIT')
      return { status, inserted: status === 'sent', errorCode }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'cron-deliveries-list') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const runId = text(args.runId, 'CRON_RUN')
    if (!cronRun(runId, workspaceId)) throw new Error('BUSINESS_CRON_RUN_NOT_FOUND')
    return db
      .prepare(
        `
      SELECT id,run_id,tool_call_id,kind,status,started_at,finished_at,error_code,
             retry_of_id,attempt_number,plugin_id,chat_id
      FROM cron_run_deliveries WHERE run_id=? ORDER BY started_at,id
    `
      )
      .all(runId)
  }
  if (method === 'cron-delivery-reconcile') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const runId = text(args.runId, 'CRON_RUN')
    const deliveryId = text(args.id, 'CRON_DELIVERY')
    const outcome = text(args.outcome, 'CRON_DELIVERY_OUTCOME')
    if (!['sent', 'failed'].includes(outcome)) throw new Error('INVALID_CRON_DELIVERY_OUTCOME')
    if (!cronRun(runId, workspaceId)) throw new Error('BUSINESS_CRON_RUN_NOT_FOUND')
    const changed = db
      .prepare(
        `
        UPDATE cron_run_deliveries
        SET status=?,finished_at=?,error_code=?
        WHERE id=? AND run_id=? AND status='unknown'
      `
      )
      .run(
        outcome,
        timestamp(args.confirmedAt, 'CRON_DELIVERY_CONFIRMED_AT'),
        outcome === 'sent' ? 'MANUALLY_CONFIRMED_SENT' : 'MANUALLY_CONFIRMED_FAILED',
        deliveryId,
        runId
      ).changes
    if (!changed) throw new Error('BUSINESS_CRON_DELIVERY_NOT_RECONCILABLE')
    return true
  }
  if (method === 'cron-delivery-retry-prepare') {
    const maxDeliveryAttempts = 3
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const runId = text(args.runId, 'CRON_RUN')
    const retryOfId = text(args.retryOfId, 'CRON_DELIVERY')
    db.exec('BEGIN IMMEDIATE')
    try {
      const run = db
        .prepare(
          `
          SELECT r.status FROM cron_runs r JOIN cron_jobs j ON j.id=r.job_id
          WHERE r.id=? AND j.workspace_id=?
        `
        )
        .get(runId, workspaceId)
      if (!run) throw new Error('BUSINESS_CRON_RUN_NOT_FOUND')
      if (run.status !== 'success') throw new Error('CRON_DELIVERY_RETRY_REQUIRES_SUCCESSFUL_RUN')
      const parent = db
        .prepare(
          `
          SELECT kind,status,plugin_id,chat_id,attempt_number
          FROM cron_run_deliveries WHERE id=? AND run_id=?
        `
        )
        .get(retryOfId, runId)
      if (!parent || parent.status !== 'failed')
        throw new Error('CRON_DELIVERY_RETRY_REQUIRES_CONFIRMED_FAILURE')
      if (parent.kind !== 'channel' || !parent.plugin_id || !parent.chat_id)
        throw new Error('CRON_DELIVERY_RETRY_TARGET_UNAVAILABLE')
      if (parent.attempt_number >= maxDeliveryAttempts)
        throw new Error('CRON_DELIVERY_RETRY_MAX_ATTEMPTS_REACHED')
      if (db.prepare('SELECT id FROM cron_run_deliveries WHERE retry_of_id=?').get(retryOfId))
        throw new Error('CRON_DELIVERY_RETRY_ALREADY_CREATED')
      const id = text(args.id, 'CRON_DELIVERY')
      const attemptNumber = timestamp(parent.attempt_number, 'CRON_DELIVERY_ATTEMPT') + 1
      db.prepare(
        `
        INSERT INTO cron_run_deliveries
          (id,run_id,tool_call_id,kind,status,started_at,retry_of_id,attempt_number,plugin_id,chat_id)
        VALUES (?,?,?,'channel','pending',?,?,?,?,?)
      `
      ).run(
        id,
        runId,
        text(args.toolCallId, 'CRON_TOOL_CALL'),
        timestamp(args.startedAt, 'CRON_DELIVERY_STARTED_AT'),
        retryOfId,
        attemptNumber,
        parent.plugin_id,
        parent.chat_id
      )
      db.exec('COMMIT')
      return { deliveryId: id, pluginId: parent.plugin_id, chatId: parent.chat_id, attemptNumber }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'qq-wakeup-record-source') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const pluginId = text(args.pluginId, 'PLUGIN')
    const openId = text(args.openId, 'QQ_OPEN_ID')
    const sourceMessageId = text(args.sourceMessageId, 'QQ_SOURCE_MESSAGE')
    const sourceTimestamp = timestamp(args.sourceTimestamp, 'QQ_SOURCE_TIMESTAMP')
    const now = timestamp(args.now, 'QQ_NOW')
    return db
      .prepare(
        `INSERT INTO qq_wakeup_windows_v2
      (workspace_id,plugin_id,open_id,period_key,source_message_id,source_timestamp,
       sent_at,created_at,updated_at)
      VALUES (?,?,?,'__source__',?,?,?,?,?)
      ON CONFLICT(workspace_id,plugin_id,open_id,period_key) DO UPDATE SET
        source_message_id=excluded.source_message_id,
        source_timestamp=excluded.source_timestamp,
        updated_at=excluded.updated_at
      WHERE excluded.source_timestamp > qq_wakeup_windows_v2.source_timestamp`
      )
      .run(workspaceId, pluginId, openId, sourceMessageId, sourceTimestamp, now, now, now).changes
  }
  if (method === 'qq-wakeup-resolve') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const pluginId = text(args.pluginId, 'PLUGIN')
    const openId = text(args.openId, 'QQ_OPEN_ID')
    const now = timestamp(args.now, 'QQ_NOW')
    const source = db
      .prepare(
        `SELECT source_message_id,source_timestamp
      FROM qq_wakeup_windows_v2
      WHERE workspace_id=? AND plugin_id=? AND open_id=? AND period_key='__source__'`
      )
      .get(workspaceId, pluginId, openId)
    const sourceTimestamp = source?.source_timestamp ?? now
    const age = now - sourceTimestamp
    const day = 24 * 60 * 60 * 1000
    const periodKey =
      age < 0 || age >= 30 * day
        ? null
        : age < day
          ? 'day-0'
          : age < 3 * day
            ? 'day-1-3'
            : age < 7 * day
              ? 'day-3-7'
              : 'day-7-30'
    const sent =
      periodKey === null
        ? null
        : db
            .prepare(
              `SELECT 1
      FROM qq_wakeup_windows_v2
      WHERE workspace_id=? AND plugin_id=? AND open_id=? AND period_key=?`
            )
            .get(workspaceId, pluginId, openId, periodKey)
    return {
      enabled: periodKey !== null && !sent,
      periodKey,
      sourceMessageId: source?.source_message_id ?? null,
      sourceTimestamp
    }
  }
  if (method === 'qq-wakeup-mark-sent') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const pluginId = text(args.pluginId, 'PLUGIN')
    const openId = text(args.openId, 'QQ_OPEN_ID')
    const periodKey = text(args.periodKey, 'QQ_PERIOD')
    const sourceMessageId = nullableText(args.sourceMessageId, 'QQ_SOURCE_MESSAGE')
    const sourceTimestamp = timestamp(args.sourceTimestamp, 'QQ_SOURCE_TIMESTAMP')
    const now = timestamp(args.now, 'QQ_NOW')
    return db
      .prepare(
        `INSERT INTO qq_wakeup_windows_v2
      (workspace_id,plugin_id,open_id,period_key,source_message_id,source_timestamp,
       sent_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id,plugin_id,open_id,period_key) DO UPDATE SET
        source_message_id=excluded.source_message_id,
        source_timestamp=excluded.source_timestamp,
        sent_at=excluded.sent_at,
        updated_at=excluded.updated_at`
      )
      .run(
        workspaceId,
        pluginId,
        openId,
        periodKey,
        sourceMessageId,
        sourceTimestamp,
        now,
        now,
        now
      ).changes
  }
  if (method === 'channel-session-route') {
    const pluginId = text(args.pluginId, 'PLUGIN')
    const chatId = channelChatId(args.chatId)
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const chatName = channelTitle(args.chatName)
    const senderName = channelTitle(args.senderName)
    const projectId = channelTitle(args.projectId)
    const providerId = sessionProviderId(channelTitle(args.providerId), workspaceId)
    const modelId = channelTitle(args.modelId)
    const modelSource = channelModelSource(args.modelSource, workspaceId)
    const compositeKey = `plugin:${pluginId}:chat:${encodeURIComponent(chatId)}`
    const legacyPrefix = `${compositeKey}:message:`
    const now = Date.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      const project = projectId
        ? db
            .prepare(
              'SELECT id,working_folder,ssh_connection_id,workspace_id FROM projects WHERE id=?'
            )
            .get(projectId)
        : null
      if (project && project.workspace_id !== workspaceId)
        throw new Error('BUSINESS_CHANNEL_PROJECT_WORKSPACE_MISMATCH')
      let existing = db
        .prepare(
          'SELECT id,title,workspace_id,plugin_id FROM sessions WHERE external_chat_id=? LIMIT 1'
        )
        .get(compositeKey)
      let fromLegacy = false
      if (!existing) {
        existing = db
          .prepare(
            `SELECT id,title,workspace_id,plugin_id FROM sessions
             WHERE plugin_id=? AND substr(external_chat_id,1,?)=?
             ORDER BY updated_at DESC LIMIT 1`
          )
          .get(pluginId, legacyPrefix.length, legacyPrefix)
        fromLegacy = Boolean(existing)
      }
      if (existing && (existing.workspace_id !== workspaceId || existing.plugin_id !== pluginId))
        throw new Error('BUSINESS_CHANNEL_SESSION_WORKSPACE_MISMATCH')
      const selectionMode = providerId && modelId ? 'manual' : 'inherit'
      let sessionId
      let sessionTitle
      if (!existing) {
        sessionId = `oc_${randomUUID().replaceAll('-', '')}`
        sessionTitle = chatName ?? senderName ?? chatId
        db.prepare(
          `INSERT INTO sessions
          (id,title,mode,created_at,updated_at,message_count,project_id,working_folder,
           ssh_connection_id,pinned,plugin_id,external_chat_id,provider_id,model_id,
           model_selection_mode,workspace_id,model_source)
           VALUES(?,?,'cowork',?,?,0,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          sessionId,
          sessionTitle,
          now,
          now,
          project?.id ?? null,
          project?.working_folder ?? null,
          project?.ssh_connection_id ?? null,
          0,
          pluginId,
          compositeKey,
          providerId,
          modelId,
          selectionMode,
          workspaceId,
          modelSource
        )
      } else {
        sessionId = existing.id
        sessionTitle = existing.title
        if (fromLegacy)
          db.prepare('UPDATE sessions SET external_chat_id=? WHERE id=? AND workspace_id=?').run(
            compositeKey,
            sessionId,
            workspaceId
          )
        if (project) {
          db.prepare(
            `UPDATE sessions SET updated_at=?,project_id=?,working_folder=?,ssh_connection_id=?
             WHERE id=? AND workspace_id=?`
          ).run(
            now,
            project.id,
            project.working_folder,
            project.ssh_connection_id,
            sessionId,
            workspaceId
          )
        } else {
          db.prepare('UPDATE sessions SET updated_at=? WHERE id=? AND workspace_id=?').run(
            now,
            sessionId,
            workspaceId
          )
        }
        if (providerId || modelId || modelSource) {
          db.prepare(
            `UPDATE sessions SET provider_id=?,model_id=?,model_source=?,model_selection_mode=?
             WHERE id=? AND workspace_id=?`
          ).run(providerId, modelId, modelSource, selectionMode, sessionId, workspaceId)
        }
        const betterTitle = chatName ?? senderName
        if (shouldReplaceChannelTitle(sessionTitle, betterTitle)) {
          db.prepare('UPDATE sessions SET title=? WHERE id=? AND workspace_id=?').run(
            betterTitle,
            sessionId,
            workspaceId
          )
          sessionTitle = betterTitle
        }
      }
      db.exec('COMMIT')
      return {
        sessionId,
        sessionTitle,
        projectId: project?.id ?? null,
        workingFolder: project?.working_folder ?? null,
        sshConnectionId: project?.ssh_connection_id ?? null
      }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'channel-session-create') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'SESSION')
    const pluginId = text(args.pluginId, 'PLUGIN')
    const projectId = nullableText(args.projectId, 'PROJECT')
    const project = projectId
      ? db
          .prepare(
            `SELECT id,working_folder,ssh_connection_id FROM projects
             WHERE id=? AND workspace_id=?`
          )
          .get(projectId, workspaceId)
      : null
    if (projectId && !project) throw new Error('BUSINESS_CHANNEL_PROJECT_NOT_FOUND')
    const now = Date.now()
    const createdAt = timestamp(args.createdAt ?? now, 'CREATED_AT')
    const providerId = sessionProviderId(args.providerId, workspaceId)
    const modelId = providerId ? normalizedOptionalText(args.modelId, 'MODEL') : null
    db.prepare(
      `INSERT INTO sessions
      (id,title,mode,created_at,updated_at,message_count,project_id,working_folder,
       ssh_connection_id,pinned,plugin_id,external_chat_id,provider_id,model_id,
       model_selection_mode,workspace_id)
       VALUES(?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      text(args.title, 'TITLE'),
      args.mode === undefined ? 'cowork' : text(args.mode, 'MODE'),
      createdAt,
      timestamp(args.updatedAt ?? createdAt, 'UPDATED_AT'),
      project?.id ?? null,
      project?.working_folder ?? null,
      project?.ssh_connection_id ?? null,
      0,
      pluginId,
      nullableText(args.externalChatId, 'EXTERNAL_CHAT'),
      providerId,
      modelId,
      providerId && modelId ? 'manual' : 'inherit',
      workspaceId
    )
    return channelSession(id, workspaceId)
  }
  if (method === 'channel-session-rename') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    return (
      db
        .prepare(
          `UPDATE sessions SET title=?,updated_at=?
       WHERE id=? AND workspace_id=? AND plugin_id IS NOT NULL AND plugin_id!=''`
        )
        .run(
          text(args.title, 'TITLE'),
          timestamp(args.updatedAt ?? Date.now(), 'UPDATED_AT'),
          sessionId,
          workspaceId
        ).changes > 0
    )
  }
  if (method === 'channel-session-clear') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!channelSession(sessionId, workspaceId)) {
        db.exec('COMMIT')
        return 0
      }
      const deleted = db.prepare('DELETE FROM messages WHERE session_id=?').run(sessionId).changes
      db.prepare('UPDATE sessions SET message_count=0 WHERE id=? AND workspace_id=?').run(
        sessionId,
        workspaceId
      )
      db.exec('COMMIT')
      return deleted
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'channel-session-delete') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!channelSession(sessionId, workspaceId)) {
        db.exec('COMMIT')
        return false
      }
      db.prepare('DELETE FROM tasks WHERE session_id=?').run(sessionId)
      db.prepare('DELETE FROM messages WHERE session_id=?').run(sessionId)
      db.prepare('DELETE FROM sessions WHERE id=? AND workspace_id=?').run(sessionId, workspaceId)
      db.exec('COMMIT')
      return true
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'channel-data-remove') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const pluginId = text(args.pluginId, 'PLUGIN')
    db.exec('BEGIN IMMEDIATE')
    try {
      const deleted = db
        .prepare(
          `SELECT COUNT(*) AS count FROM messages WHERE session_id IN
           (SELECT id FROM sessions WHERE plugin_id=? AND workspace_id=?)`
        )
        .get(pluginId, workspaceId).count
      const deletedSessions = db
        .prepare('DELETE FROM sessions WHERE plugin_id=? AND workspace_id=?')
        .run(pluginId, workspaceId).changes
      const deletedProjects = db
        .prepare('DELETE FROM projects WHERE plugin_id=? AND workspace_id=?')
        .run(pluginId, workspaceId).changes
      db.exec('COMMIT')
      return { changed: deletedSessions + deletedProjects, deleted }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'session-create') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const projectId = nullableText(args.projectId, 'PROJECT')
    const planId = normalizedOptionalText(args.planId, 'PLAN')
    assertExistingSessionPlanOwner(planId, text(args.id, 'SESSION'))
    const providerId = sessionProviderId(args.providerId, workspaceId)
    const modelId = normalizedOptionalText(args.modelId, 'MODEL')
    const modelSelectionMode =
      normalizedOptionalText(args.modelSelectionMode, 'MODEL_SELECTION') ??
      (providerId && modelId ? 'manual' : 'inherit')
    const project = projectId
      ? db
          .prepare(
            'SELECT id,working_folder,ssh_connection_id FROM projects WHERE id=? AND workspace_id=?'
          )
          .get(projectId, workspaceId)
      : null
    if (projectId && !project) throw new Error('BUSINESS_PROJECT_NOT_FOUND')
    const workingFolder =
      normalizedOptionalText(args.workingFolder, 'WORKING_FOLDER') ??
      project?.working_folder ??
      null
    const sshConnectionId =
      normalizedOptionalText(args.sshConnectionId, 'SSH') ?? project?.ssh_connection_id ?? null
    db.prepare(
      `INSERT INTO sessions (
        id,title,icon,mode,created_at,updated_at,message_count,project_id,working_folder,
        ssh_connection_id,plan_id,pinned,plugin_id,external_chat_id,provider_id,model_id,
        model_selection_mode,model_source,task_profile,task_profile_locked,scenario_policy,workspace_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      text(args.id, 'SESSION'),
      text(args.title, 'TITLE'),
      nullableText(args.icon, 'ICON'),
      text(args.mode, 'MODE'),
      timestamp(args.createdAt, 'CREATED_AT'),
      timestamp(args.updatedAt, 'UPDATED_AT'),
      0,
      projectId,
      workingFolder,
      sshConnectionId,
      planId,
      args.pinned === undefined ? 0 : bool(args.pinned, 'PINNED'),
      nullableText(args.pluginId, 'PLUGIN'),
      nullableText(args.externalChatId, 'EXTERNAL_CHAT'),
      providerId,
      modelId,
      modelSelectionMode,
      sessionProjectModelSource(args.modelSource, workspaceId),
      args.taskProfile == null ? null : taskProfile(args.taskProfile),
      args.taskProfileLocked === undefined
        ? 0
        : bool(args.taskProfileLocked, 'TASK_PROFILE_LOCKED'),
      scenarioPolicy(args.scenarioPolicy),
      workspaceId
    )
    return session(text(args.id, 'SESSION'), workspaceId)
  }
  if (method === 'message-upsert') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const input = messageInput(args, workspaceId)
    const { id, sessionId } = input
    db.exec('BEGIN IMMEDIATE')
    try {
      assertMessageIdOwner(id, sessionId)
      db.prepare(
        `INSERT INTO messages(id,session_id,role,content,meta,created_at,usage,sort_order)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET role=excluded.role,content=excluded.content,meta=excluded.meta,
         usage=excluded.usage,sort_order=excluded.sort_order`
      ).run(
        id,
        sessionId,
        input.role,
        input.content,
        input.meta,
        input.createdAt,
        input.usage,
        input.sortOrder
      )
      db.prepare(
        'UPDATE sessions SET message_count=(SELECT COUNT(*) FROM messages WHERE session_id=?), updated_at=? WHERE id=? AND workspace_id=?'
      ).run(sessionId, timestamp(args.updatedAt, 'UPDATED_AT'), sessionId, workspaceId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return true
  }
  if (method === 'message-add') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const input = messageInput(args, workspaceId)
    db.exec('BEGIN IMMEDIATE')
    try {
      const changed = Number(insertMessage(input))
      setSessionMessageCount(input.sessionId, workspaceId)
      db.exec('COMMIT')
      return changed
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'messages-add-batch') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    if (!Array.isArray(args.messages)) throw new Error('INVALID_BUSINESS_MESSAGES')
    const inputs = args.messages.map((input) => messageInput(input, workspaceId))
    db.exec('BEGIN IMMEDIATE')
    try {
      let changed = 0
      const sessions = new Set()
      for (const input of inputs) {
        changed += Number(insertMessage(input))
        sessions.add(input.sessionId)
      }
      for (const sessionId of sessions) setSessionMessageCount(sessionId, workspaceId)
      db.exec('COMMIT')
      return changed
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'message-update') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'MESSAGE')
    const owner = db
      .prepare(
        `SELECT m.session_id FROM messages m JOIN sessions s ON s.id=m.session_id
         WHERE m.id=? AND s.workspace_id=?`
      )
      .get(id, workspaceId)
    if (!owner) throw new Error('BUSINESS_MESSAGE_NOT_FOUND')
    const patch = args.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw new Error('INVALID_BUSINESS_MESSAGE_PATCH')
    const columns = []
    const values = []
    for (const [property, column, field] of [
      ['content', 'content', 'MESSAGE_CONTENT'],
      ['meta', 'meta', 'MESSAGE_META'],
      ['usage', 'usage', 'MESSAGE_USAGE']
    ]) {
      if (!Object.hasOwn(patch, property)) continue
      columns.push(`${column}=?`)
      values.push(
        property === 'content'
          ? messageValue(patch[property], field)
          : optionalMessageValue(patch[property], field)
      )
    }
    if (!columns.length) return 0
    return Number(
      db
        .prepare(
          `UPDATE messages SET ${columns.join(',')} WHERE id=? AND session_id IN
           (SELECT id FROM sessions WHERE workspace_id=?)`
        )
        .run(...values, id, workspaceId).changes
    )
  }
  if (method === 'messages-clear') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    if (args.clearTasks !== undefined && typeof args.clearTasks !== 'boolean')
      throw new Error('INVALID_BUSINESS_CLEAR_TASKS')
    const updatedAt =
      args.updatedAt === undefined ? undefined : timestamp(args.updatedAt, 'UPDATED_AT')
    db.exec('BEGIN IMMEDIATE')
    try {
      if (args.clearTasks) {
        db.prepare('DELETE FROM tasks WHERE session_id=?').run(sessionId)
      }
      const changed = Number(
        db
          .prepare(
            `DELETE FROM messages WHERE session_id=? AND session_id IN
             (SELECT id FROM sessions WHERE workspace_id=?)`
          )
          .run(sessionId, workspaceId).changes
      )
      setSessionMessageCount(sessionId, workspaceId)
      if (updatedAt !== undefined)
        db.prepare('UPDATE sessions SET updated_at=? WHERE id=? AND workspace_id=?').run(
          updatedAt,
          sessionId,
          workspaceId
        )
      db.exec('COMMIT')
      return changed
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'messages-replace') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    if (!Array.isArray(args.messages)) throw new Error('INVALID_BUSINESS_MESSAGES')
    const inputs = args.messages.map((input) => messageInput(input, workspaceId, sessionId))
    for (const input of inputs) assertMessageIdOwner(input.id, sessionId)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM messages WHERE session_id=?').run(sessionId)
      for (const input of inputs) insertMessage(input, 'INSERT OR REPLACE')
      setSessionMessageCount(sessionId, workspaceId)
      db.exec('COMMIT')
      return inputs.length
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'messages-truncate-from') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    const fromSortOrder = timestamp(args.fromSortOrder ?? 0, 'SORT_ORDER')
    db.exec('BEGIN IMMEDIATE')
    try {
      const removed = Number(
        db
          .prepare(
            `DELETE FROM messages WHERE session_id=? AND sort_order>=? AND session_id IN
             (SELECT id FROM sessions WHERE workspace_id=?)`
          )
          .run(sessionId, fromSortOrder, workspaceId).changes
      )
      setSessionMessageCount(sessionId, workspaceId)
      db.exec('COMMIT')
      return removed
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'message-delete-last') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    const role = text(args.role, 'ROLE')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row =
        db
          .prepare(
            `SELECT id,session_id,role,content,meta,created_at,usage,sort_order
             FROM messages WHERE session_id=? AND role=? ORDER BY sort_order DESC LIMIT 1`
          )
          .get(sessionId, role) ?? null
      if (row) db.prepare('DELETE FROM messages WHERE id=? AND session_id=?').run(row.id, sessionId)
      setSessionMessageCount(sessionId, workspaceId)
      db.exec('COMMIT')
      return row
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'messages-insert-artifacts') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    if (!Array.isArray(args.messages)) throw new Error('INVALID_BUSINESS_MESSAGES')
    const inputs = args.messages
      .filter((input) => input && typeof input === 'object' && !Array.isArray(input))
      .map((input) => messageInput(input, workspaceId, sessionId))
      .filter(isCompactArtifact)
    for (const input of inputs) assertMessageIdOwner(input.id, sessionId)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `DELETE FROM messages WHERE session_id=? AND
         (meta LIKE '%compactBoundary%' OR meta LIKE '%compactSummary%'
          OR content LIKE '%[Context Memory Compressed Summary]%')`
      ).run(sessionId)
      const deleteIncoming = db.prepare('DELETE FROM messages WHERE session_id=? AND id=?')
      for (const input of inputs) deleteIncoming.run(sessionId, input.id)
      normalizeSessionMessageSortOrders(sessionId)
      const totalBeforeInsert = Number(
        db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(sessionId)
          ?.count ?? 0
      )
      if (!inputs.length) {
        const total = setSessionMessageCount(sessionId, workspaceId)
        db.exec('COMMIT')
        return { success: true, inserted: 0, start: 0, end: 0, total }
      }
      let insertSortOrder = Number.isSafeInteger(args.insertSortOrder)
        ? args.insertSortOrder
        : totalBeforeInsert
      if (typeof args.insertBeforeMessageId === 'string' && args.insertBeforeMessageId.trim()) {
        const anchor = db
          .prepare('SELECT sort_order FROM messages WHERE session_id=? AND id=?')
          .get(sessionId, args.insertBeforeMessageId.trim())
        if (anchor) insertSortOrder = Number(anchor.sort_order)
      }
      insertSortOrder = Math.min(
        Math.max(insertSortOrder < 0 ? totalBeforeInsert : insertSortOrder, 0),
        totalBeforeInsert
      )
      db.prepare(
        'UPDATE messages SET sort_order=sort_order+? WHERE session_id=? AND sort_order>=?'
      ).run(inputs.length, sessionId, insertSortOrder)
      for (let index = 0; index < inputs.length; index++) {
        insertMessage({ ...inputs[index], sortOrder: insertSortOrder + index }, 'INSERT OR REPLACE')
      }
      const total = setSessionMessageCount(sessionId, workspaceId)
      db.exec('COMMIT')
      return {
        success: true,
        inserted: inputs.length,
        start: insertSortOrder,
        end: insertSortOrder + inputs.length,
        total
      }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'message-delete') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = db
        .prepare('DELETE FROM messages WHERE id=? AND session_id=?')
        .run(text(args.id, 'MESSAGE'), sessionId)
      if (!result.changes) throw new Error('BUSINESS_MESSAGE_NOT_FOUND')
      db.prepare(
        'UPDATE sessions SET message_count=(SELECT COUNT(*) FROM messages WHERE session_id=?), updated_at=? WHERE id=? AND workspace_id=?'
      ).run(sessionId, timestamp(args.updatedAt, 'UPDATED_AT'), sessionId, workspaceId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return true
  }
  if (method === 'session-update') {
    if (Object.hasOwn(args, 'scenarioPolicy')) throw new Error('BUSINESS_SCENARIO_POLICY_IMMUTABLE')
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'SESSION')
    if (!session(id, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    if (args.planId !== undefined)
      assertExistingSessionPlanOwner(normalizedOptionalText(args.planId, 'PLAN'), id)
    if (args.projectId !== undefined && args.projectId !== null) {
      const projectId = text(args.projectId, 'PROJECT')
      const project = db
        .prepare('SELECT id FROM projects WHERE id=? AND workspace_id=?')
        .get(projectId, workspaceId)
      if (!project) throw new Error('BUSINESS_PROJECT_NOT_FOUND')
    }
    const { changes, values } = updateFields(
      args,
      [
        ['title', 'title', (value) => text(value, 'TITLE')],
        ['icon', 'icon', (value) => nullableText(value, 'ICON')],
        ['mode', 'mode', (value) => text(value, 'MODE')],
        ['project_id', 'projectId', (value) => nullableText(value, 'PROJECT')],
        ['working_folder', 'workingFolder', (value) => nullableText(value, 'WORKING_FOLDER')],
        ['ssh_connection_id', 'sshConnectionId', (value) => nullableText(value, 'SSH')],
        ['plan_id', 'planId', (value) => normalizedOptionalText(value, 'PLAN')],
        ['pinned', 'pinned', (value) => bool(value, 'PINNED')],
        ['plugin_id', 'pluginId', (value) => nullableText(value, 'PLUGIN')],
        ['external_chat_id', 'externalChatId', (value) => nullableText(value, 'EXTERNAL_CHAT')],
        ['provider_id', 'providerId', (value) => sessionProviderId(value, workspaceId)],
        ['model_id', 'modelId', (value) => nullableText(value, 'MODEL')],
        [
          'model_selection_mode',
          'modelSelectionMode',
          (value) => nullableText(value, 'MODEL_SELECTION')
        ],
        ['model_source', 'modelSource', (value) => sessionProjectModelSource(value, workspaceId)],
        ['task_profile', 'taskProfile', taskProfile],
        ['task_profile_locked', 'taskProfileLocked', (value) => bool(value, 'TASK_PROFILE_LOCKED')]
      ],
      args.updatedAt
    )
    db.prepare(`UPDATE sessions SET ${changes.join(', ')} WHERE id=? AND workspace_id=?`).run(
      ...values,
      id,
      workspaceId
    )
    return session(id, workspaceId)
  }
  if (method === 'session-delete') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'SESSION')
    if (!session(id, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM tasks WHERE session_id=?').run(id)
      db.prepare('DELETE FROM messages WHERE session_id=?').run(id)
      db.prepare('DELETE FROM sessions WHERE id=? AND workspace_id=?').run(id, workspaceId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return true
  }
  if (method === 'sessions-clear-all') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    db.exec('BEGIN IMMEDIATE')
    try {
      const sessionIds = db
        .prepare('SELECT id FROM sessions WHERE plugin_id IS NULL AND workspace_id=?')
        .all(workspaceId)
        .map((row) => row.id)
      const deletedMessages = db
        .prepare(
          `DELETE FROM messages WHERE session_id IN (
            SELECT id FROM sessions WHERE plugin_id IS NULL AND workspace_id=?
          )`
        )
        .run(workspaceId).changes
      const deletedSessions = db
        .prepare('DELETE FROM sessions WHERE plugin_id IS NULL AND workspace_id=?')
        .run(workspaceId).changes
      db.exec('COMMIT')
      return { success: true, sessionIds, deletedMessages, deletedSessions, error: null }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'session-reset-conversation') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    const updatedAt = Date.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      const deletedMessages = db
        .prepare(
          `DELETE FROM messages WHERE session_id=?
           AND session_id IN (SELECT id FROM sessions WHERE workspace_id=?)`
        )
        .run(sessionId, workspaceId).changes
      db.prepare(
        `UPDATE sessions SET title='New Conversation', updated_at=?, message_count=0
         WHERE id=? AND workspace_id=?`
      ).run(updatedAt, sessionId, workspaceId)
      db.exec('COMMIT')
      return { success: true, deletedMessages, updatedAt, error: null }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'project-create') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    db.prepare(
      `INSERT INTO projects(
        id,name,working_folder,ssh_connection_id,plugin_id,pinned,created_at,updated_at,
        workspace_id,model_source
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(
      text(args.id, 'PROJECT'),
      text(args.name, 'PROJECT_NAME'),
      nullableText(args.workingFolder, 'WORKING_FOLDER'),
      nullableText(args.sshConnectionId, 'SSH'),
      nullableText(args.pluginId, 'PLUGIN'),
      args.pinned === undefined ? 0 : bool(args.pinned, 'PINNED'),
      timestamp(args.createdAt, 'CREATED_AT'),
      timestamp(args.updatedAt, 'UPDATED_AT'),
      workspaceId,
      sessionProjectModelSource(args.modelSource, workspaceId)
    )
    return db
      .prepare('SELECT * FROM projects WHERE id=? AND workspace_id=?')
      .get(text(args.id, 'PROJECT'), workspaceId)
  }
  if (method === 'project-ensure-default' || method === 'project-ensure-plugin') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const baseDirectory = text(args.baseDirectory, 'PROJECT_BASE_DIRECTORY')
    const pluginId = method === 'project-ensure-plugin' ? text(args.pluginId, 'PLUGIN') : null
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = pluginId
        ? db
            .prepare(
              `SELECT * FROM projects WHERE plugin_id=? AND workspace_id=?
               ORDER BY pinned DESC, updated_at DESC LIMIT 1`
            )
            .get(pluginId, workspaceId)
        : db
            .prepare(
              `SELECT * FROM projects WHERE plugin_id IS NULL AND workspace_id=?
               ORDER BY pinned DESC, updated_at DESC LIMIT 1`
            )
            .get(workspaceId)
      if (existing) {
        if (!pluginId && existing.working_folder === null && existing.ssh_connection_id === null) {
          const allocated = allocateProjectDirectory(baseDirectory, existing.name)
          db.prepare(
            `UPDATE projects SET name=?,working_folder=?,ssh_connection_id=NULL,updated_at=?
             WHERE id=? AND workspace_id=?`
          ).run(allocated.name, allocated.workingFolder, Date.now(), existing.id, workspaceId)
        }
        const result = db
          .prepare('SELECT * FROM projects WHERE id=? AND workspace_id=?')
          .get(existing.id, workspaceId)
        db.exec('COMMIT')
        return result
      }
      const preferredName =
        pluginId === null
          ? typeof args.preferredName === 'string' && args.preferredName.trim()
            ? args.preferredName.trim()
            : 'New Project'
          : typeof args.preferredName === 'string' && args.preferredName.trim()
            ? args.preferredName.trim()
            : `Plugin ${pluginId}`
      const allocated = allocateProjectDirectory(baseDirectory, preferredName)
      const id = `oc_${randomUUID().replaceAll('-', '')}`
      const now = Date.now()
      db.prepare(
        `INSERT INTO projects(id,name,working_folder,ssh_connection_id,plugin_id,pinned,
          created_at,updated_at,workspace_id,model_source)
         VALUES(?,?,?,NULL,?,0,?,?,?,NULL)`
      ).run(id, allocated.name, allocated.workingFolder, pluginId, now, now, workspaceId)
      const result = db
        .prepare('SELECT * FROM projects WHERE id=? AND workspace_id=?')
        .get(id, workspaceId)
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'project-update') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'PROJECT')
    const { changes, values } = updateFields(
      args,
      [
        ['name', 'name', (value) => text(value, 'PROJECT_NAME')],
        ['working_folder', 'workingFolder', (value) => nullableText(value, 'WORKING_FOLDER')],
        ['ssh_connection_id', 'sshConnectionId', (value) => nullableText(value, 'SSH')],
        ['plugin_id', 'pluginId', (value) => nullableText(value, 'PLUGIN')],
        ['pinned', 'pinned', (value) => bool(value, 'PINNED')],
        ['model_source', 'modelSource', (value) => sessionProjectModelSource(value, workspaceId)]
      ],
      undefined
    )
    const directoryChanged = args.workingFolder !== undefined || args.sshConnectionId !== undefined
    db.exec('BEGIN IMMEDIATE')
    try {
      const exists = db
        .prepare('SELECT id, updated_at FROM projects WHERE id=? AND workspace_id=?')
        .get(id, workspaceId)
      if (!exists) throw new Error('BUSINESS_PROJECT_NOT_FOUND')
      const requestedUpdatedAt = timestamp(args.updatedAt ?? Date.now(), 'UPDATED_AT')
      const committedUpdatedAt = Math.max(requestedUpdatedAt, exists.updated_at + 1)
      db.prepare(
        `UPDATE projects SET ${changes.join(', ')}, updated_at=? WHERE id=? AND workspace_id=?`
      ).run(...values, committedUpdatedAt, id, workspaceId)
      const updated = db
        .prepare('SELECT * FROM projects WHERE id=? AND workspace_id=?')
        .get(id, workspaceId)
      if (directoryChanged) {
        db.prepare(
          `UPDATE sessions SET working_folder=?,ssh_connection_id=?,updated_at=?
            WHERE project_id=? AND workspace_id=?`
        ).run(
          updated.working_folder,
          updated.ssh_connection_id,
          updated.updated_at,
          id,
          workspaceId
        )
      }
      db.exec('COMMIT')
      return updated
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'project-delete') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'PROJECT')
    const exists = db
      .prepare('SELECT id FROM projects WHERE id=? AND workspace_id=?')
      .get(id, workspaceId)
    if (!exists) throw new Error('BUSINESS_PROJECT_NOT_FOUND')
    const inUse = db
      .prepare('SELECT 1 FROM sessions WHERE project_id=? AND workspace_id=? LIMIT 1')
      .get(id, workspaceId)
    if (inUse) throw new Error('BUSINESS_PROJECT_IN_USE')
    db.prepare('DELETE FROM projects WHERE id=? AND workspace_id=?').run(id, workspaceId)
    return true
  }
  if (method === 'plan-create') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    const id = text(args.id, 'PLAN')
    db.prepare(
      `INSERT INTO plans(id,session_id,title,status,file_path,content,spec_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      sessionId,
      text(args.title, 'PLAN_TITLE'),
      text(args.status ?? 'drafting', 'PLAN_STATUS'),
      nullableText(args.filePath, 'FILE_PATH'),
      nullableText(args.content, 'CONTENT'),
      args.spec === undefined || args.spec === null ? null : JSON.stringify(args.spec),
      timestamp(args.createdAt, 'CREATED_AT'),
      timestamp(args.updatedAt, 'UPDATED_AT')
    )
    return plan(id, workspaceId, sessionId)
  }
  if (method === 'plan-update') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'PLAN')
    if (!plan(id, workspaceId)) throw new Error('BUSINESS_PLAN_NOT_FOUND')
    const { changes, values } = updateFields(
      args,
      [
        ['title', 'title', (value) => text(value, 'PLAN_TITLE')],
        ['status', 'status', (value) => text(value, 'PLAN_STATUS')],
        ['file_path', 'filePath', (value) => nullableText(value, 'FILE_PATH')],
        ['content', 'content', (value) => nullableText(value, 'CONTENT')],
        ['spec_json', 'spec', (value) => (value === null ? null : JSON.stringify(value))]
      ],
      args.updatedAt
    )
    db.prepare(
      `UPDATE plans SET ${changes.join(', ')} WHERE id=? AND session_id IN (
        SELECT id FROM sessions WHERE workspace_id=?
      )`
    ).run(...values, id, workspaceId)
    return plan(id, workspaceId)
  }
  if (method === 'plan-delete') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'PLAN')
    const current = plan(id, workspaceId)
    if (!current) throw new Error('BUSINESS_PLAN_NOT_FOUND')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE tasks SET plan_id=NULL WHERE plan_id=? AND session_id=?').run(
        id,
        current.session_id
      )
      db.prepare('DELETE FROM plans WHERE id=? AND session_id=?').run(id, current.session_id)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return true
  }
  if (method === 'goal-create' || method === 'goal-replace') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    const goalId =
      args.goalId === undefined
        ? `oc_${randomUUID().replaceAll('-', '')}`
        : text(args.goalId, 'GOAL')
    const objective = text(args.objective, 'OBJECTIVE')
    const tokenBudget = nullableInteger(args.tokenBudget, 'TOKEN_BUDGET')
    if (tokenBudget !== null && tokenBudget <= 0) throw new Error('BUSINESS_GOAL_BUDGET_INVALID')
    const status =
      method === 'goal-create' ? 'active' : text(args.status ?? 'active', 'GOAL_STATUS')
    if (
      !['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'].includes(
        status
      )
    )
      throw new Error('BUSINESS_GOAL_STATUS_INVALID')
    const now = timestamp(args.createdAt ?? Date.now(), 'CREATED_AT')
    db.exec('BEGIN IMMEDIATE')
    try {
      const previous = goal(sessionId, workspaceId)
      if (method === 'goal-create' && previous) {
        db.exec('COMMIT')
        return null
      }
      db.prepare(
        `INSERT INTO session_goals
           (session_id,goal_id,objective,status,token_budget,tokens_used,time_used_seconds,created_at,updated_at)
         VALUES(?,?,?,?,?,0,0,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           goal_id=excluded.goal_id, objective=excluded.objective, status=excluded.status,
           token_budget=excluded.token_budget, tokens_used=0, time_used_seconds=0,
           created_at=excluded.created_at, updated_at=excluded.updated_at`
      ).run(sessionId, goalId, objective, status, tokenBudget, now, now)
      db.prepare(
        `INSERT INTO session_goal_events
           (id,session_id,goal_id,event_type,message,metadata_json,created_at)
         VALUES(?,?,?,?,NULL,?,?)`
      ).run(
        `oc_${randomUUID().replaceAll('-', '')}`,
        sessionId,
        goalId,
        previous ? 'replaced' : 'created',
        JSON.stringify(method === 'goal-create' ? { tokenBudget } : { status, tokenBudget }),
        now
      )
      db.exec('COMMIT')
      return goal(sessionId, workspaceId)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'goal-update') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    const patch = args.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null
    const tokenBudgetPatched = Object.hasOwn(patch, 'tokenBudget')
    const tokenBudget = tokenBudgetPatched
      ? nullableInteger(patch.tokenBudget, 'TOKEN_BUDGET')
      : undefined
    if (tokenBudget !== undefined && tokenBudget !== null && tokenBudget <= 0)
      throw new Error('BUSINESS_GOAL_BUDGET_INVALID')
    const objectivePatch =
      patch.objective === undefined ? undefined : text(patch.objective, 'OBJECTIVE')
    const statusPatch = patch.status === undefined ? undefined : text(patch.status, 'GOAL_STATUS')
    if (
      statusPatch !== undefined &&
      !['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'].includes(
        statusPatch
      )
    )
      throw new Error('BUSINESS_GOAL_STATUS_INVALID')
    const now = timestamp(args.updatedAt ?? Date.now(), 'UPDATED_AT')
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = goal(sessionId, workspaceId)
      if (!current) {
        db.exec('COMMIT')
        return null
      }
      const objectiveChanged =
        objectivePatch !== undefined && objectivePatch.trim() !== current.objective.trim()
      const nextBudget = tokenBudgetPatched ? tokenBudget : current.token_budget
      const nextObjective = objectivePatch ?? current.objective
      const nextGoalId = objectiveChanged
        ? args.goalId === undefined
          ? `oc_${randomUUID().replaceAll('-', '')}`
          : text(args.goalId, 'GOAL')
        : current.goal_id
      const nextTokens = objectiveChanged ? 0 : current.tokens_used
      const nextTime = objectiveChanged ? 0 : current.time_used_seconds
      const statusBasis =
        statusPatch ??
        (objectiveChanged &&
        ['complete', 'budget_limited', 'usage_limited', 'blocked'].includes(current.status)
          ? 'active'
          : current.status)
      const nextStatus =
        ['active', 'paused'].includes(statusBasis) &&
        nextBudget !== null &&
        nextTokens >= nextBudget
          ? 'budget_limited'
          : statusBasis
      db.prepare(
        `UPDATE session_goals SET goal_id=?, objective=?, status=?, token_budget=?,
                tokens_used=?, time_used_seconds=?, created_at=?, updated_at=?
          WHERE session_id=?`
      ).run(
        nextGoalId,
        nextObjective,
        nextStatus,
        nextBudget,
        nextTokens,
        nextTime,
        objectiveChanged ? now : current.created_at,
        now,
        sessionId
      )
      const row = goal(sessionId, workspaceId)
      const addEvent = (eventType, metadata) =>
        db
          .prepare(
            `INSERT INTO session_goal_events
             (id,session_id,goal_id,event_type,message,metadata_json,created_at)
           VALUES(?,?,?,?,NULL,?,?)`
          )
          .run(
            `oc_${randomUUID().replaceAll('-', '')}`,
            sessionId,
            nextGoalId,
            eventType,
            metadata === null ? null : JSON.stringify(metadata),
            now
          )
      if (objectiveChanged) {
        addEvent('objective_updated', {
          previousGoalId: current.goal_id,
          previousObjective: current.objective,
          status: nextStatus,
          tokenBudget: nextBudget
        })
      } else if (objectivePatch !== undefined && nextObjective !== current.objective) {
        addEvent('objective_updated', null)
      }
      if (tokenBudgetPatched && nextBudget !== current.token_budget)
        addEvent('budget_updated', { tokenBudget: nextBudget, tokensUsed: nextTokens })
      if (nextStatus !== current.status) {
        const eventType =
          nextStatus === 'budget_limited' ||
          nextStatus === 'usage_limited' ||
          nextStatus === 'blocked'
            ? nextStatus
            : 'status_changed'
        addEvent(eventType, { from: current.status, to: nextStatus })
      }
      db.exec('COMMIT')
      return row
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'goal-upsert') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    db.prepare(
      `INSERT INTO session_goals(
        session_id,goal_id,objective,status,token_budget,tokens_used,time_used_seconds,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET goal_id=excluded.goal_id,objective=excluded.objective,
        status=excluded.status,token_budget=excluded.token_budget,tokens_used=excluded.tokens_used,
        time_used_seconds=excluded.time_used_seconds,updated_at=excluded.updated_at`
    ).run(
      sessionId,
      text(args.goalId, 'GOAL'),
      text(args.objective, 'OBJECTIVE'),
      text(args.status, 'GOAL_STATUS'),
      nullableInteger(args.tokenBudget, 'TOKEN_BUDGET'),
      timestamp(args.tokensUsed ?? 0, 'TOKENS_USED'),
      timestamp(args.timeUsedSeconds ?? 0, 'TIME_USED_SECONDS'),
      timestamp(args.createdAt, 'CREATED_AT'),
      timestamp(args.updatedAt, 'UPDATED_AT')
    )
    return goal(sessionId, workspaceId)
  }
  if (method === 'goal-event-append') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    const goalId =
      args.goalId === undefined || args.goalId === null ? null : text(args.goalId, 'GOAL')
    db.prepare(
      `INSERT INTO session_goal_events(id,session_id,goal_id,event_type,message,metadata_json,created_at)
       VALUES(?,?,?,?,?,?,?)`
    ).run(
      text(args.id, 'GOAL_EVENT'),
      sessionId,
      goalId,
      text(args.eventType, 'GOAL_EVENT_TYPE'),
      nullableText(args.message, 'GOAL_EVENT_MESSAGE'),
      args.metadata === undefined ||
        args.metadata === null ||
        (typeof args.metadata === 'object' && Object.keys(args.metadata).length === 0)
        ? null
        : JSON.stringify(args.metadata),
      timestamp(args.createdAt, 'CREATED_AT')
    )
    return true
  }
  if (method === 'goal-account-usage') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    const timeDeltaSeconds = timestamp(
      Math.max(0, args.timeDeltaSeconds ?? 0),
      'TIME_DELTA_SECONDS'
    )
    const tokenDelta = timestamp(Math.max(0, args.tokenDelta ?? 0), 'TOKEN_DELTA')
    const expectedGoalId =
      args.expectedGoalId == null || args.expectedGoalId === ''
        ? null
        : text(args.expectedGoalId, 'GOAL')
    if (timeDeltaSeconds === 0 && tokenDelta === 0) return goal(sessionId, workspaceId)
    const now = timestamp(args.updatedAt ?? Date.now(), 'UPDATED_AT')
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = goal(sessionId, workspaceId)
      const row = db
        .prepare(
          `UPDATE session_goals
              SET time_used_seconds=time_used_seconds+?, tokens_used=tokens_used+?,
                  status=CASE WHEN status IN ('active','paused') AND token_budget IS NOT NULL
                                   AND tokens_used+? >= token_budget
                              THEN 'budget_limited' ELSE status END,
                  updated_at=?
            WHERE session_id=? AND (? IS NULL OR goal_id=?)
            RETURNING session_id,goal_id,objective,status,token_budget,tokens_used,
                      time_used_seconds,created_at,updated_at`
        )
        .get(
          timeDeltaSeconds,
          tokenDelta,
          tokenDelta,
          now,
          sessionId,
          expectedGoalId,
          expectedGoalId
        )
      if (row) {
        db.prepare(
          `INSERT INTO session_goal_events
             (id,session_id,goal_id,event_type,message,metadata_json,created_at)
           VALUES(?,?,?,'usage_accounted',NULL,?,?)`
        ).run(
          randomUUID(),
          sessionId,
          row.goal_id,
          JSON.stringify({
            timeDeltaSeconds,
            tokenDelta,
            tokensUsed: row.tokens_used,
            timeUsedSeconds: row.time_used_seconds
          }),
          now
        )
        if (current?.status !== 'budget_limited' && row.status === 'budget_limited') {
          db.prepare(
            `INSERT INTO session_goal_events
               (id,session_id,goal_id,event_type,message,metadata_json,created_at)
             VALUES(?,?,?,'budget_limited',NULL,?,?)`
          ).run(
            randomUUID(),
            sessionId,
            row.goal_id,
            JSON.stringify({ tokenBudget: row.token_budget, tokensUsed: row.tokens_used }),
            now
          )
        }
      }
      db.exec('COMMIT')
      return row ?? null
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'goals-clear') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId))
      return { success: false, cleared: false, error: 'BUSINESS_SESSION_NOT_FOUND' }
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = goal(sessionId, workspaceId)
      if (!current) {
        db.exec('COMMIT')
        return { success: true, cleared: false, error: null }
      }
      db.prepare('DELETE FROM session_goals WHERE session_id=?').run(sessionId)
      db.prepare(
        `INSERT INTO session_goal_events(id,session_id,goal_id,event_type,message,metadata_json,created_at)
         VALUES(?,?,?,'cleared',NULL,NULL,?)`
      ).run(randomUUID(), sessionId, current.goal_id, Date.now())
      db.exec('COMMIT')
      return { success: true, cleared: true, error: null }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'goal-delete') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    const current = goal(sessionId, workspaceId)
    if (!current) return false
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM session_goals WHERE session_id=?').run(sessionId)
      db.prepare(
        `INSERT INTO session_goal_events(id,session_id,goal_id,event_type,message,metadata_json,created_at)
         VALUES(?,?,?,'cleared',NULL,NULL,?)`
      ).run(randomUUID(), sessionId, current.goal_id, Date.now())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return true
  }
  if (method === 'task-create') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    if (args.planId !== undefined && args.planId !== null) {
      if (!plan(text(args.planId, 'PLAN'), workspaceId, sessionId))
        throw new Error('BUSINESS_PLAN_NOT_FOUND')
    }
    db.prepare(
      `INSERT INTO tasks(
        id,session_id,plan_id,subject,description,active_form,status,owner,blocks,blocked_by,
        metadata,sort_order,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      text(args.id, 'TASK'),
      sessionId,
      nullableText(args.planId, 'PLAN'),
      text(args.subject, 'TASK_SUBJECT'),
      text(args.description, 'TASK_DESCRIPTION'),
      nullableText(args.activeForm, 'ACTIVE_FORM'),
      text(args.status ?? 'pending', 'TASK_STATUS'),
      nullableText(args.owner, 'OWNER'),
      list(args.blocks ?? [], 'BLOCKS'),
      list(args.blockedBy ?? [], 'BLOCKED_BY'),
      args.metadata === undefined || args.metadata === null ? null : JSON.stringify(args.metadata),
      timestamp(args.sortOrder, 'SORT_ORDER'),
      timestamp(args.createdAt, 'CREATED_AT'),
      timestamp(args.updatedAt, 'UPDATED_AT')
    )
    return true
  }
  if (method === 'task-update') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'TASK')
    const existingTask = task(id, workspaceId)
    if (!existingTask) throw new Error('BUSINESS_TASK_NOT_FOUND')
    if (args.planId !== undefined && args.planId !== null) {
      if (!plan(text(args.planId, 'PLAN'), workspaceId, existingTask.session_id))
        throw new Error('BUSINESS_PLAN_NOT_FOUND')
    }
    const { changes, values } = updateFields(
      args,
      [
        ['plan_id', 'planId', (value) => nullableText(value, 'PLAN')],
        ['subject', 'subject', (value) => text(value, 'TASK_SUBJECT')],
        ['description', 'description', (value) => text(value, 'TASK_DESCRIPTION')],
        ['active_form', 'activeForm', (value) => nullableText(value, 'ACTIVE_FORM')],
        ['status', 'status', (value) => text(value, 'TASK_STATUS')],
        ['owner', 'owner', (value) => nullableText(value, 'OWNER')],
        ['blocks', 'blocks', (value) => list(value, 'BLOCKS')],
        ['blocked_by', 'blockedBy', (value) => list(value, 'BLOCKED_BY')],
        ['metadata', 'metadata', (value) => (value === null ? null : JSON.stringify(value))],
        ['sort_order', 'sortOrder', (value) => timestamp(value, 'SORT_ORDER')]
      ],
      args.updatedAt
    )
    const expectedUpdatedAt =
      args.expectedUpdatedAt === undefined
        ? undefined
        : timestamp(args.expectedUpdatedAt, 'EXPECTED_UPDATED_AT')
    const result = db
      .prepare(
        `UPDATE tasks SET ${changes.join(', ')} WHERE id=?${expectedUpdatedAt === undefined ? '' : ' AND updated_at=?'}`
      )
      .run(...values, id, ...(expectedUpdatedAt === undefined ? [] : [expectedUpdatedAt]))
    if (expectedUpdatedAt !== undefined && result.changes === 0)
      throw new Error('BUSINESS_TASK_CONFLICT')
    return true
  }
  if (method === 'task-delete') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const id = text(args.id, 'TASK')
    if (!task(id, workspaceId)) throw new Error('BUSINESS_TASK_NOT_FOUND')
    const expectedUpdatedAt =
      args.expectedUpdatedAt === undefined
        ? undefined
        : timestamp(args.expectedUpdatedAt, 'EXPECTED_UPDATED_AT')
    const result = db
      .prepare(
        `DELETE FROM tasks WHERE id=?${expectedUpdatedAt === undefined ? '' : ' AND updated_at=?'}`
      )
      .run(id, ...(expectedUpdatedAt === undefined ? [] : [expectedUpdatedAt]))
    if (expectedUpdatedAt !== undefined && result.changes === 0)
      throw new Error('BUSINESS_TASK_CONFLICT')
    return true
  }
  if (method === 'tasks-delete-by-session') {
    const workspaceId = text(args.workspaceId, 'WORKSPACE')
    const sessionId = text(args.sessionId, 'SESSION')
    if (!session(sessionId, workspaceId)) throw new Error('BUSINESS_SESSION_NOT_FOUND')
    return db
      .prepare(
        `DELETE FROM tasks WHERE session_id=?
         AND session_id IN (SELECT id FROM sessions WHERE workspace_id=?)`
      )
      .run(sessionId, workspaceId).changes
  }
  if (method === 'ssh-groups-list')
    return db
      .prepare(
        'SELECT id,name,sort_order,created_at,updated_at FROM ssh_groups ORDER BY sort_order ASC'
      )
      .all()
  if (method === 'ssh-groups-create') {
    db.prepare(
      'INSERT INTO ssh_groups(id,name,sort_order,created_at,updated_at) VALUES(?,?,?,?,?)'
    ).run(
      text(args.id, 'SSH_GROUP'),
      text(args.name, 'SSH_GROUP_NAME'),
      timestamp(args.sortOrder ?? 0, 'SSH_SORT_ORDER'),
      timestamp(args.createdAt, 'SSH_CREATED_AT'),
      timestamp(args.updatedAt, 'SSH_UPDATED_AT')
    )
    return { success: true, changed: 1 }
  }
  if (method === 'ssh-groups-update') {
    const id = text(args.id, 'SSH_GROUP')
    const patch = args.patch && typeof args.patch === 'object' ? args.patch : {}
    const changes = []
    const values = []
    if (patch.name !== undefined) {
      changes.push('name=?')
      values.push(text(patch.name, 'SSH_GROUP_NAME'))
    }
    if (patch.sortOrder !== undefined) {
      changes.push('sort_order=?')
      values.push(timestamp(patch.sortOrder, 'SSH_SORT_ORDER'))
    }
    if (patch.updatedAt !== undefined) {
      changes.push('updated_at=?')
      values.push(timestamp(patch.updatedAt, 'SSH_UPDATED_AT'))
    }
    if (!changes.length) return { success: true, changed: 0 }
    const result = db
      .prepare(`UPDATE ssh_groups SET ${changes.join(',')} WHERE id=?`)
      .run(...values, id)
    return { success: true, changed: result.changes }
  }
  if (method === 'ssh-groups-delete') {
    const id = text(args.id, 'SSH_GROUP')
    db.prepare('UPDATE ssh_connections SET group_id=NULL WHERE group_id=?').run(id)
    const result = db.prepare('DELETE FROM ssh_groups WHERE id=?').run(id)
    return { success: true, changed: result.changes }
  }
  if (method === 'ssh-connections-list')
    return db
      .prepare(
        `SELECT id,group_id,name,host,port,username,auth_type,encrypted_password,
         private_key_path,encrypted_passphrase,startup_command,default_directory,proxy_jump,
         keep_alive_interval,sort_order,last_connected_at,created_at,updated_at
         FROM ssh_connections ORDER BY sort_order ASC`
      )
      .all()
  if (method === 'ssh-connections-get') {
    const connection = db
      .prepare(
        `SELECT id,group_id,name,host,port,username,auth_type,encrypted_password,
         private_key_path,encrypted_passphrase,startup_command,default_directory,proxy_jump,
         keep_alive_interval,sort_order,last_connected_at,created_at,updated_at
         FROM ssh_connections WHERE id=? LIMIT 1`
      )
      .get(text(args.id, 'SSH_CONNECTION'))
    return { success: true, connection: connection ?? null }
  }
  if (method === 'ssh-connections-create') {
    db.prepare(
      `INSERT INTO ssh_connections(id,group_id,name,host,port,username,auth_type,encrypted_password,
       private_key_path,encrypted_passphrase,startup_command,default_directory,proxy_jump,
       keep_alive_interval,sort_order,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      text(args.id, 'SSH_CONNECTION'),
      nullableText(args.groupId, 'SSH_GROUP'),
      text(args.name, 'SSH_NAME'),
      text(args.host, 'SSH_HOST'),
      timestamp(args.port ?? 22, 'SSH_PORT'),
      text(args.username, 'SSH_USERNAME'),
      text(args.authType ?? 'password', 'SSH_AUTH_TYPE'),
      nullableText(args.encryptedPassword, 'SSH_PASSWORD'),
      nullableText(args.privateKeyPath, 'SSH_KEY'),
      nullableText(args.encryptedPassphrase, 'SSH_PASSPHRASE'),
      nullableText(args.startupCommand, 'SSH_STARTUP'),
      nullableText(args.defaultDirectory, 'SSH_DIRECTORY'),
      nullableText(args.proxyJump, 'SSH_PROXY_JUMP'),
      timestamp(args.keepAliveInterval ?? 60, 'SSH_KEEP_ALIVE'),
      timestamp(args.sortOrder ?? 0, 'SSH_SORT_ORDER'),
      timestamp(args.createdAt, 'SSH_CREATED_AT'),
      timestamp(args.updatedAt, 'SSH_UPDATED_AT')
    )
    return { success: true, changed: 1 }
  }
  if (method === 'ssh-connections-update') {
    const id = text(args.id, 'SSH_CONNECTION')
    const patch = args.patch && typeof args.patch === 'object' ? args.patch : {}
    const fields = [
      ['group_id', 'groupId', (value) => nullableText(value, 'SSH_GROUP')],
      ['name', 'name', (value) => text(value, 'SSH_NAME')],
      ['host', 'host', (value) => text(value, 'SSH_HOST')],
      ['port', 'port', (value) => timestamp(value, 'SSH_PORT')],
      ['username', 'username', (value) => text(value, 'SSH_USERNAME')],
      ['auth_type', 'authType', (value) => text(value, 'SSH_AUTH_TYPE')],
      ['encrypted_password', 'encryptedPassword', (value) => nullableText(value, 'SSH_PASSWORD')],
      ['private_key_path', 'privateKeyPath', (value) => nullableText(value, 'SSH_KEY')],
      [
        'encrypted_passphrase',
        'encryptedPassphrase',
        (value) => nullableText(value, 'SSH_PASSPHRASE')
      ],
      ['startup_command', 'startupCommand', (value) => nullableText(value, 'SSH_STARTUP')],
      ['default_directory', 'defaultDirectory', (value) => nullableText(value, 'SSH_DIRECTORY')],
      ['proxy_jump', 'proxyJump', (value) => nullableText(value, 'SSH_PROXY_JUMP')],
      ['keep_alive_interval', 'keepAliveInterval', (value) => timestamp(value, 'SSH_KEEP_ALIVE')],
      ['sort_order', 'sortOrder', (value) => timestamp(value, 'SSH_SORT_ORDER')],
      [
        'last_connected_at',
        'lastConnectedAt',
        (value) => (value === null ? null : timestamp(value, 'SSH_LAST_CONNECTED'))
      ],
      ['updated_at', 'updatedAt', (value) => timestamp(value, 'SSH_UPDATED_AT')]
    ]
    const changes = []
    const values = []
    for (const [column, key, normalize] of fields) {
      if (patch[key] === undefined) continue
      changes.push(`${column}=?`)
      values.push(normalize(patch[key]))
    }
    if (!changes.length) return { success: true, changed: 0 }
    const result = db
      .prepare(`UPDATE ssh_connections SET ${changes.join(',')} WHERE id=?`)
      .run(...values, id)
    return { success: true, changed: result.changes }
  }
  if (method === 'ssh-connections-delete') {
    const result = db
      .prepare('DELETE FROM ssh_connections WHERE id=?')
      .run(text(args.id, 'SSH_CONNECTION'))
    return { success: true, changed: result.changes }
  }
  if (method === 'normalize-message-sort-orders') {
    db.exec('BEGIN IMMEDIATE')
    try {
      const sessions = db
        .prepare(
          `SELECT session_id FROM messages GROUP BY session_id
           HAVING MIN(sort_order) <> 0
              OR MAX(sort_order) <> COUNT(*) - 1
              OR COUNT(DISTINCT sort_order) <> COUNT(*)`
        )
        .all()
      const read = db.prepare(
        `SELECT id, role, created_at, sort_order FROM messages
         WHERE session_id=? ORDER BY sort_order ASC, created_at ASC`
      )
      const update = db.prepare('UPDATE messages SET sort_order=? WHERE id=?')
      const roleOrder = { user: 0, assistant: 1, system: 2 }
      let repairedMessages = 0
      for (const { session_id: sessionId } of sessions) {
        const ordered = read.all(sessionId).sort((a, b) => {
          return (
            a.created_at - b.created_at ||
            (roleOrder[a.role] ?? 10) - (roleOrder[b.role] ?? 10) ||
            a.sort_order - b.sort_order
          )
        })
        for (let index = 0; index < ordered.length; index++) {
          if (ordered[index].sort_order === index) continue
          update.run(index, ordered[index].id)
          repairedMessages++
        }
      }
      db.exec('COMMIT')
      return { repairedSessions: sessions.length, repairedMessages }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (method === 'sync-capture-local')
    return syncCaptureLocal(text(args.providerId, 'SYNC_PROVIDER'))
  if (method === 'sync-apply-db-merge') return syncApplyDbMerge(args)
  if (method === 'sync-save-metadata') return syncSaveMetadata(args)
  if (method === 'migration-status')
    return db
      .prepare(
        'SELECT version, applied_at, description FROM ola_ts_schema_migrations ORDER BY version'
      )
      .all()
  if (method === 'pending-session-queue-get') {
    const sessionId = text(args.sessionId, 'SESSION_ID')
    const workspaceId = text(args.workspaceId, 'WORKSPACE_ID')
    const row = db
      .prepare(
        'SELECT messages_json FROM ola_pending_session_queues WHERE session_id=? AND workspace_id=?'
      )
      .get(sessionId, workspaceId)
    if (!row) return []
    const messages = JSON.parse(row.messages_json)
    return Array.isArray(messages) ? messages : []
  }
  if (method === 'pending-session-queue-replace') {
    const sessionId = text(args.sessionId, 'SESSION_ID')
    const workspaceId = text(args.workspaceId, 'WORKSPACE_ID')
    if (!Array.isArray(args.messages) || args.messages.length > 51)
      throw new Error('INVALID_BUSINESS_PENDING_SESSION_QUEUE')
    const ids = new Set()
    for (const message of args.messages) {
      if (
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        typeof message.id !== 'string' ||
        !message.id.trim() ||
        message.id.length > 256 ||
        ids.has(message.id) ||
        typeof message.text !== 'string' ||
        message.text.length > 1_000_000 ||
        !Number.isFinite(message.createdAt) ||
        message.createdAt <= 0 ||
        (message.dispatchMode !== undefined &&
          !['after_loop', 'interrupt_next'].includes(message.dispatchMode)) ||
        (message.source !== undefined &&
          !['team', 'queued', 'continue', 'quoted'].includes(message.source)) ||
        (message.recoveryState !== undefined &&
          !['dispatching', 'needs_review'].includes(message.recoveryState)) ||
        (message.images !== undefined && !Array.isArray(message.images)) ||
        (message.options !== undefined &&
          (!message.options ||
            typeof message.options !== 'object' ||
            Array.isArray(message.options)))
      )
        throw new Error('INVALID_BUSINESS_PENDING_SESSION_QUEUE')
      ids.add(message.id)
      if (message.images && message.images.length > 64)
        throw new Error('INVALID_BUSINESS_PENDING_SESSION_QUEUE')
      for (const image of message.images ?? []) {
        if (
          !image ||
          typeof image !== 'object' ||
          typeof image.id !== 'string' ||
          typeof image.dataUrl !== 'string' ||
          typeof image.mediaType !== 'string'
        )
          throw new Error('INVALID_BUSINESS_PENDING_SESSION_QUEUE')
      }
    }
    const messagesJson = JSON.stringify(args.messages)
    if (Buffer.byteLength(messagesJson, 'utf8') > 32 * 1024 * 1024)
      throw new Error('BUSINESS_PENDING_SESSION_QUEUE_TOO_LARGE')
    if (args.messages.length === 0) {
      db.prepare(
        'DELETE FROM ola_pending_session_queues WHERE session_id=? AND workspace_id=?'
      ).run(sessionId, workspaceId)
      return true
    }
    db.prepare(
      `INSERT INTO ola_pending_session_queues(session_id, workspace_id, messages_json, updated_at)
       VALUES(?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         workspace_id=excluded.workspace_id,
         messages_json=excluded.messages_json,
         updated_at=excluded.updated_at`
    ).run(sessionId, workspaceId, messagesJson, Date.now())
    return true
  }
  if (method === 'close') {
    db.close()
    lease.exec('ROLLBACK')
    lease.close()
    return true
  }
  throw new Error('BUSINESS_METHOD_UNAVAILABLE')
}

parentPort.on('message', ({ id, method, args }) => {
  try {
    parentPort.postMessage({ id, result: dispatch(method, args) })
  } catch (error) {
    parentPort.postMessage({
      id,
      error: error instanceof Error ? error.message : 'BUSINESS_DATABASE_FAILED'
    })
  }
})
