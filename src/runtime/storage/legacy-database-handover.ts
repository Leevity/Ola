import { backup, DatabaseSync } from 'node:sqlite'
import { createReadStream, constants as fsConstants } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  statfs,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { RuntimeError } from '../../shared/runtime/contracts'

export interface LegacyDatabaseHandoverSnapshot {
  sourcePath: string
  quiescedSource?: { realPath: string; footprint: string }
  backupPath: string
  rollbackPath: string
  manifestPath: string
  createdAt: string
  sourceSize: number
  backupSize: number
  rollbackSize: number
  rollbackSha256: string
  userVersion: number
  tables: string[]
}

function snapshotFromUnknown(value: unknown, manifestPath: string): LegacyDatabaseHandoverSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('LEGACY_DATABASE_HANDOVER_MANIFEST_INVALID')
  const snapshot = value as Partial<LegacyDatabaseHandoverSnapshot>
  if (
    typeof snapshot.sourcePath !== 'string' ||
    (snapshot.quiescedSource !== undefined &&
      (typeof snapshot.quiescedSource?.realPath !== 'string' ||
        typeof snapshot.quiescedSource?.footprint !== 'string')) ||
    typeof snapshot.backupPath !== 'string' ||
    typeof snapshot.rollbackPath !== 'string' ||
    typeof snapshot.manifestPath !== 'string' ||
    typeof snapshot.createdAt !== 'string' ||
    !Number.isSafeInteger(snapshot.sourceSize) ||
    !Number.isSafeInteger(snapshot.backupSize) ||
    !Number.isSafeInteger(snapshot.rollbackSize) ||
    typeof snapshot.rollbackSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(snapshot.rollbackSha256) ||
    !Number.isSafeInteger(snapshot.userVersion) ||
    !Array.isArray(snapshot.tables) ||
    snapshot.tables.some((table) => typeof table !== 'string') ||
    resolve(snapshot.manifestPath) !== resolve(manifestPath)
  )
    throw new RuntimeError('LEGACY_DATABASE_HANDOVER_MANIFEST_INVALID')
  return snapshot as LegacyDatabaseHandoverSnapshot
}

type SchemaInspection = { userVersion: number; tables: string[] }

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function syncHandoverFile(path: string): Promise<void> {
  // Windows requires a writable handle for FlushFileBuffers, including files
  // that we only need to flush after a completed copy or backup.
  const handle = await open(path, process.platform === 'win32' ? 'r+' : 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncHandoverDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  await syncHandoverFile(path)
}

async function sourceFootprint(sourcePath: string): Promise<string> {
  const hashes = await Promise.all(
    [sourcePath, `${sourcePath}-wal`].map(async (file) => {
      const fileStat = await stat(file).catch(() => null)
      return fileStat?.isFile() ? await sha256File(file) : null
    })
  )
  return JSON.stringify(hashes)
}

/**
 * The business-data contract that the staged TS repositories can read during
 * the ownership handover. It is intentionally smaller than the complete
 * legacy schema: unknown tables are preserved by SQLite backup, while these
 * tables and columns are required to retain workspace-scoped conversations,
 * projects and tasks safely.
 */
export const LEGACY_BUSINESS_DATABASE_CONTRACT: Readonly<Record<string, readonly string[]>> = {
  sessions: [
    'id',
    'title',
    'icon',
    'mode',
    'created_at',
    'updated_at',
    'message_count',
    'project_id',
    'working_folder',
    'ssh_connection_id',
    'plan_id',
    'pinned',
    'plugin_id',
    'external_chat_id',
    'provider_id',
    'model_id',
    'model_selection_mode',
    'model_source',
    'workspace_id'
  ],
  messages: ['id', 'session_id', 'role', 'content', 'meta', 'created_at', 'usage', 'sort_order'],
  projects: [
    'id',
    'name',
    'working_folder',
    'ssh_connection_id',
    'plugin_id',
    'pinned',
    'created_at',
    'updated_at',
    'workspace_id',
    'model_source'
  ],
  plans: [
    'id',
    'session_id',
    'title',
    'status',
    'file_path',
    'content',
    'spec_json',
    'created_at',
    'updated_at'
  ],
  session_goals: [
    'session_id',
    'goal_id',
    'objective',
    'status',
    'token_budget',
    'tokens_used',
    'time_used_seconds',
    'created_at',
    'updated_at'
  ],
  session_goal_events: [
    'id',
    'session_id',
    'goal_id',
    'event_type',
    'message',
    'metadata_json',
    'created_at'
  ],
  cron_jobs: [
    'id',
    'name',
    'schedule_kind',
    'schedule_at',
    'schedule_every',
    'schedule_expr',
    'schedule_tz',
    'prompt',
    'agent_id',
    'model',
    'model_source',
    'working_folder',
    'ssh_connection_id',
    'session_id',
    'source_session_title',
    'source_project_id',
    'source_project_name',
    'source_provider_id',
    'delivery_mode',
    'delivery_target',
    'plugin_id',
    'plugin_chat_id',
    'enabled',
    'delete_after_run',
    'max_iterations',
    'deleted_at',
    'last_fired_at',
    'fire_count',
    'created_at',
    'updated_at',
    'workspace_id'
  ],
  cron_runs: [
    'id',
    'job_id',
    'started_at',
    'finished_at',
    'status',
    'tool_call_count',
    'output_summary',
    'error',
    'scheduled_for',
    'job_name_snapshot',
    'prompt_snapshot',
    'source_session_id_snapshot',
    'source_session_title_snapshot',
    'source_project_id_snapshot',
    'source_project_name_snapshot',
    'source_provider_id_snapshot',
    'model_snapshot',
    'model_source_snapshot',
    'working_folder_snapshot',
    'delivery_mode_snapshot',
    'delivery_target_snapshot'
  ],
  cron_run_messages: [
    'id',
    'run_id',
    'role',
    'content',
    'usage',
    'message_source',
    'sort_order',
    'created_at'
  ],
  cron_run_logs: ['id', 'run_id', 'timestamp', 'type', 'content', 'sort_order'],
  tasks: [
    'id',
    'session_id',
    'plan_id',
    'subject',
    'description',
    'active_form',
    'status',
    'owner',
    'blocks',
    'blocked_by',
    'metadata',
    'sort_order',
    'created_at',
    'updated_at'
  ],
  memory_roots: [
    'id',
    'scope',
    'project_id',
    'working_folder',
    'ssh_connection_id',
    'root_path',
    'transport',
    'owner_key',
    'created_at',
    'updated_at',
    'workspace_id'
  ],
  memory_stage1_outputs: [
    'id',
    'memory_root_id',
    'scope',
    'source_session_id',
    'source_updated_at',
    'raw_memory',
    'rollout_summary',
    'rollout_slug',
    'fingerprint',
    'status',
    'usage_count',
    'last_usage_at',
    'created_at',
    'updated_at'
  ],
  memory_jobs: [
    'id',
    'kind',
    'status',
    'memory_root_id',
    'source_session_id',
    'lease_owner',
    'lease_expires_at',
    'attempts',
    'error',
    'started_at',
    'finished_at',
    'created_at',
    'updated_at',
    'workspace_id'
  ],
  memory_automation_entries: [
    'id',
    'scope',
    'root_scope',
    'memory_root_id',
    'job_id',
    'project_id',
    'target',
    'kind',
    'content',
    'confidence',
    'source_session_id',
    'target_path',
    'status',
    'filter_reason',
    'fingerprint',
    'evidence_json',
    'written_at',
    'error',
    'before_content',
    'after_content',
    'appended_text',
    'ssh_connection_id',
    'created_at',
    'updated_at',
    'undone_at',
    'workspace_id'
  ],
  memory_automation_rollups_v2: [
    'workspace_id',
    'scope',
    'target',
    'target_path',
    'source_date',
    'content_hash',
    'processed_at'
  ],
  memory_citation_usage: [
    'id',
    'memory_root_id',
    'scope',
    'source_session_id',
    'path',
    'line',
    'citation_json',
    'created_at'
  ],
  usage_events: [
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
  ],
  usage_activity_daily_v2: [
    'workspace_id',
    'day',
    'first_at',
    'last_at',
    'request_count',
    'input_tokens',
    'output_tokens',
    'cache_creation_tokens',
    'cache_read_tokens',
    'reasoning_tokens',
    'total_cost_usd',
    'updated_at'
  ],
  usage_activity_daily_models_v2: [
    'workspace_id',
    'day',
    'provider_id',
    'provider_name',
    'model_id',
    'model_name',
    'request_count',
    'input_tokens',
    'output_tokens',
    'cache_creation_tokens',
    'cache_read_tokens',
    'reasoning_tokens',
    'total_cost_usd',
    'updated_at'
  ],
  usage_activity_daily_providers_v2: [
    'workspace_id',
    'day',
    'provider_id',
    'provider_name',
    'provider_type',
    'provider_builtin_id',
    'provider_base_url',
    'request_count',
    'input_tokens',
    'output_tokens',
    'cache_creation_tokens',
    'cache_read_tokens',
    'reasoning_tokens',
    'total_cost_usd',
    'updated_at'
  ],
  draw_runs: [
    'id',
    'workspace_id',
    'prompt',
    'provider_name',
    'model_name',
    'mode',
    'meta_json',
    'created_at',
    'is_generating',
    'images_json',
    'error_json',
    'updated_at'
  ],
  agent_change_sets: [
    'run_id',
    'session_id',
    'workspace_id',
    'assistant_message_id',
    'status',
    'created_at',
    'updated_at'
  ],
  agent_file_changes: [
    'id',
    'run_id',
    'session_id',
    'tool_use_id',
    'tool_name',
    'file_path',
    'transport',
    'connection_id',
    'op',
    'status',
    'before_json',
    'after_json',
    'created_at',
    'reverted_at',
    'sort_order'
  ],
  sub_agent_history: [
    'id',
    'session_id',
    'sub_agent_id',
    'tool_use_id',
    'name',
    'status',
    'started_at',
    'completed_at',
    'updated_at',
    'sort_order',
    'snapshot_json'
  ],
  app_migrations: ['key', 'applied_at'],
  runtime_tool_results: [
    'session_id',
    'tool_use_id',
    'run_id',
    'tool_name',
    'status',
    'content_json',
    'is_error',
    'started_at',
    'completed_at'
  ],
  runtime_jobs: [
    'job_id',
    'run_id',
    'session_id',
    'method',
    'state',
    'idempotency_key',
    'lane_key',
    'params_json',
    'error_code',
    'error_message',
    'created_at',
    'updated_at',
    'finished_at',
    'workspace_id'
  ],
  runtime_job_events: ['job_id', 'seq', 'payload_json', 'terminal', 'created_at'],
  qq_wakeup_windows_v2: [
    'workspace_id',
    'plugin_id',
    'open_id',
    'period_key',
    'source_message_id',
    'source_timestamp',
    'sent_at',
    'created_at',
    'updated_at'
  ],
  wiki_documents: ['project_root', 'document_json', 'generated_at', 'updated_at'],
  wiki_nodes: ['project_root', 'node_path', 'node_json', 'updated_at'],
  wiki_file_snapshots: [
    'project_root',
    'file_path',
    'content_hash',
    'size_bytes',
    'modified_at',
    'updated_at'
  ],
  wiki_generation_runs: [
    'id',
    'project_root',
    'state',
    'error_message',
    'started_at',
    'finished_at'
  ],
  desktop_flows: ['id', 'name', 'flow_json', 'created_at', 'updated_at', 'workspace_id'],
  desktop_flow_steps: ['flow_id', 'step_id', 'sort_order', 'step_json', 'updated_at'],
  desktop_flow_runs: ['id', 'flow_id', 'state', 'error_message', 'started_at', 'finished_at']
}

const NATIVE_PROJECT_WIKI_CONTRACT: Readonly<Record<string, readonly string[]>> = {
  wiki_documents: [
    'id',
    'project_id',
    'name',
    'slug',
    'content_markdown',
    'created_at',
    'updated_at'
  ],
  wiki_generation_runs: ['id', 'project_id', 'mode', 'status', 'created_at', 'updated_at']
}

function inspect(database: DatabaseSync): SchemaInspection {
  const integrity = database.prepare('PRAGMA integrity_check').all() as Array<{
    integrity_check?: unknown
  }>
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
    throw new RuntimeError('LEGACY_DATABASE_INTEGRITY_FAILED')
  const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeyErrors.length) throw new RuntimeError('LEGACY_DATABASE_FOREIGN_KEY_FAILED')
  const tables = (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as Array<{ name?: unknown }>
  )
    .map((row) => row.name)
    .filter((name): name is string => typeof name === 'string')
  if (!tables.length) throw new RuntimeError('LEGACY_DATABASE_SCHEMA_EMPTY')
  const version = database.prepare('PRAGMA user_version').get() as
    | { user_version?: unknown }
    | undefined
  return { userVersion: Number(version?.user_version ?? 0), tables }
}

function columnsForTable(database: DatabaseSync, table: string): Set<string> {
  return new Set(
    (
      database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name?: unknown
      }>
    )
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string')
  )
}

function hasColumns(database: DatabaseSync, table: string, required: readonly string[]): boolean {
  const columns = columnsForTable(database, table)
  return required.every((column) => columns.has(column))
}

export interface LegacyBusinessDatabaseContract {
  sourcePath: string
  userVersion: number
  tables: string[]
  nativeProjectWiki?: {
    documents: number
    generationRuns: number
  }
}

/**
 * Verifies only through a read-only SQLite connection. A caller must complete
 * this check before stopping the Native Worker or promoting the backup to the
 * TS-owned service, so a partially upgraded legacy schema cannot masquerade
 * as a successful handover.
 */
export async function verifyLegacyBusinessDatabaseContract(input: {
  sourcePath: string
}): Promise<LegacyBusinessDatabaseContract> {
  if (!input.sourcePath) throw new RuntimeError('LEGACY_DATABASE_PATH_REQUIRED')
  const sourcePath = resolve(input.sourcePath)
  const sourceStat = await stat(sourcePath).catch(() => null)
  if (!sourceStat?.isFile()) throw new RuntimeError('LEGACY_DATABASE_UNAVAILABLE')
  const database = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    const inspection = inspect(database)
    let nativeProjectWiki: LegacyBusinessDatabaseContract['nativeProjectWiki']
    for (const [table, requiredColumns] of Object.entries(LEGACY_BUSINESS_DATABASE_CONTRACT)) {
      if (!inspection.tables.includes(table))
        throw new RuntimeError(`LEGACY_DATABASE_SCHEMA_UNSUPPORTED:${table}`)
      if (
        (table === 'wiki_documents' || table === 'wiki_generation_runs') &&
        hasColumns(database, table, NATIVE_PROJECT_WIKI_CONTRACT[table])
      ) {
        nativeProjectWiki ??= { documents: 0, generationRuns: 0 }
        const count = Number(
          (
            database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
              count?: unknown
            }
          ).count ?? 0
        )
        if (table === 'wiki_documents') nativeProjectWiki.documents = count
        else nativeProjectWiki.generationRuns = count
        continue
      }
      const columns = columnsForTable(database, table)
      const missing = requiredColumns.find((column) => !columns.has(column))
      if (missing) throw new RuntimeError(`LEGACY_DATABASE_SCHEMA_UNSUPPORTED:${table}.${missing}`)
    }
    return { sourcePath, ...inspection, ...(nativeProjectWiki ? { nativeProjectWiki } : {}) }
  } finally {
    database.close()
  }
}

/** Checks a private, writable destination before the caller irreversibly parks Native. */
export async function prepareLegacyHandoverBackupDirectory(
  backupDirectory: string,
  minimumFreeBytes = 0n
): Promise<string> {
  if (!backupDirectory) throw new RuntimeError('LEGACY_DATABASE_PATH_REQUIRED')
  if (minimumFreeBytes < 0n) throw new RuntimeError('LEGACY_DATABASE_BACKUP_SPACE_INVALID')
  const backupRoot = resolve(backupDirectory)
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  const backupRootStat = await lstat(backupRoot)
  if (
    !backupRootStat.isDirectory() ||
    backupRootStat.isSymbolicLink() ||
    (process.platform !== 'win32' && (backupRootStat.mode & 0o077) !== 0)
  )
    throw new RuntimeError('LEGACY_DATABASE_BACKUP_DIRECTORY_UNSAFE')
  const filesystem = await statfs(backupRoot, { bigint: true })
  if (filesystem.bavail * filesystem.bsize < minimumFreeBytes)
    throw new RuntimeError('LEGACY_DATABASE_BACKUP_SPACE_INSUFFICIENT')
  const probePath = join(backupRoot, `.ola-handover-probe-${randomUUID()}`)
  const probe = await open(probePath, 'wx', 0o600)
  try {
    await probe.writeFile('OLA_HANDOVER_BACKUP_PROBE\n')
    await probe.sync()
  } finally {
    try {
      await probe.close()
    } finally {
      await unlink(probePath).catch(() => undefined)
    }
  }
  return backupRoot
}

/** The backup, immutable rollback, and restored drill each need a full copy. */
export async function minimumLegacyHandoverFreeBytes(sourcePath: string): Promise<bigint> {
  const database = await stat(sourcePath)
  const wal = await stat(`${sourcePath}-wal`).catch(() => null)
  const sourceBytes = BigInt(database.size) + BigInt(wal?.isFile() ? wal.size : 0)
  return sourceBytes * 4n + 64n * 1024n * 1024n
}

/** Read-only counterpart to prepareLegacyHandoverBackupDirectory for UI preflight. */
export async function inspectLegacyHandoverBackupDirectory(
  backupDirectory: string,
  minimumFreeBytes = 0n
): Promise<string> {
  if (!backupDirectory) throw new RuntimeError('LEGACY_DATABASE_PATH_REQUIRED')
  if (minimumFreeBytes < 0n) throw new RuntimeError('LEGACY_DATABASE_BACKUP_SPACE_INVALID')
  const backupRoot = resolve(backupDirectory)
  const existing = await lstat(backupRoot).catch(() => null)
  let probeRoot = existing ? backupRoot : dirname(backupRoot)
  let rootStat = await lstat(probeRoot).catch(() => null)
  while (!rootStat && probeRoot !== dirname(probeRoot)) {
    probeRoot = dirname(probeRoot)
    rootStat = await lstat(probeRoot).catch(() => null)
  }
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink())
    throw new RuntimeError('LEGACY_DATABASE_BACKUP_DIRECTORY_UNAVAILABLE')
  if (process.platform !== 'win32' && existing && (rootStat.mode & 0o077) !== 0)
    throw new RuntimeError('LEGACY_DATABASE_BACKUP_DIRECTORY_UNSAFE')
  const filesystem = await statfs(probeRoot, { bigint: true })
  if (filesystem.bavail * filesystem.bsize < minimumFreeBytes)
    throw new RuntimeError('LEGACY_DATABASE_BACKUP_SPACE_INSUFFICIENT')
  return backupRoot
}

/**
 * Creates a SQLite-backup-API snapshot of the C# business database before an
 * ownership cutover. This intentionally never opens a write connection to the
 * source database: the Native Worker remains its only writer until shutdown.
 */
export async function createLegacyDatabaseHandoverSnapshot(input: {
  sourcePath: string
  backupDirectory: string
  now?: Date
  requireQuiescedSource?: boolean
  afterBackup?: () => Promise<void> | void
}): Promise<LegacyDatabaseHandoverSnapshot> {
  if (!input.sourcePath || !input.backupDirectory)
    throw new RuntimeError('LEGACY_DATABASE_PATH_REQUIRED')
  const sourcePath = resolve(input.sourcePath)
  const sourceStat = await stat(sourcePath).catch(() => null)
  if (!sourceStat?.isFile()) throw new RuntimeError('LEGACY_DATABASE_UNAVAILABLE')
  const footprintPath = input.requireQuiescedSource ? await realpath(sourcePath) : sourcePath

  await verifyLegacyBusinessDatabaseContract({ sourcePath })

  const createdAt = (input.now ?? new Date()).toISOString()
  const backupRoot = await prepareLegacyHandoverBackupDirectory(
    input.backupDirectory,
    await minimumLegacyHandoverFreeBytes(sourcePath)
  )
  const backupPath = join(backupRoot, `data-${Date.now()}-${randomUUID()}.db`)
  const rollbackPath = `${backupPath}.rollback.db`
  const manifestPath = `${backupPath}.manifest.json`
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  let completed = false
  try {
    const sourceInspection = inspect(source)
    const sourceVersion = input.requireQuiescedSource
      ? (source.prepare('PRAGMA data_version').get() as { data_version: number }).data_version
      : null
    const sourceBefore = input.requireQuiescedSource ? await sourceFootprint(footprintPath) : null
    // SQLite's backup API captures a transactionally consistent snapshot even
    // while the legacy writer is active in WAL mode.
    await backup(source, backupPath)
    await input.afterBackup?.()
    if (
      sourceVersion !== null &&
      ((source.prepare('PRAGMA data_version').get() as { data_version: number }).data_version !==
        sourceVersion ||
        (await sourceFootprint(footprintPath)) !== sourceBefore)
    )
      throw new RuntimeError('LEGACY_DATABASE_SOURCE_CHANGED_DURING_HANDOVER')
    await chmod(backupPath, 0o600)
    await syncHandoverFile(backupPath)
    const copied = new DatabaseSync(backupPath, { readOnly: true })
    let backupInspection: SchemaInspection
    try {
      backupInspection = inspect(copied)
    } finally {
      copied.close()
    }
    await verifyLegacyBusinessDatabaseContract({ sourcePath: backupPath })
    if (
      backupInspection.userVersion !== sourceInspection.userVersion ||
      JSON.stringify(backupInspection.tables) !== JSON.stringify(sourceInspection.tables)
    )
      throw new RuntimeError('LEGACY_DATABASE_BACKUP_MISMATCH')
    const backupStat = await stat(backupPath)
    if (!backupStat.isFile() || backupStat.size <= 0)
      throw new RuntimeError('LEGACY_DATABASE_BACKUP_FAILED')
    await copyFile(backupPath, rollbackPath, fsConstants.COPYFILE_EXCL)
    await syncHandoverFile(rollbackPath)
    await chmod(rollbackPath, 0o400)
    if (process.platform !== 'win32') await syncHandoverFile(rollbackPath)
    const rollbackStat = await stat(rollbackPath)
    if (!rollbackStat.isFile() || rollbackStat.size !== backupStat.size)
      throw new RuntimeError('LEGACY_DATABASE_ROLLBACK_FAILED')
    const rollbackSha256 = await sha256File(rollbackPath)
    if (rollbackSha256 !== (await sha256File(backupPath)))
      throw new RuntimeError('LEGACY_DATABASE_ROLLBACK_MISMATCH')
    const snapshot: LegacyDatabaseHandoverSnapshot = {
      sourcePath,
      ...(sourceBefore === null
        ? {}
        : { quiescedSource: { realPath: footprintPath, footprint: sourceBefore } }),
      backupPath,
      rollbackPath,
      manifestPath,
      createdAt,
      sourceSize: sourceStat.size,
      backupSize: backupStat.size,
      rollbackSize: rollbackStat.size,
      rollbackSha256,
      userVersion: sourceInspection.userVersion,
      tables: sourceInspection.tables
    }
    await writeFile(manifestPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await syncHandoverFile(manifestPath)
    await syncHandoverDirectory(backupRoot)
    completed = true
    return snapshot
  } finally {
    source.close()
    if (!completed)
      await Promise.all(
        [backupPath, rollbackPath, manifestPath].map((file) => unlink(file).catch(() => undefined))
      )
  }
}

/** Rechecks the parked source immediately before a caller promotes the TS copy. */
export async function verifyQuiescedLegacySourceUnchanged(
  snapshot: LegacyDatabaseHandoverSnapshot
): Promise<void> {
  if (!snapshot.quiescedSource) throw new RuntimeError('LEGACY_DATABASE_QUIESCED_SOURCE_REQUIRED')
  const currentPath = await realpath(snapshot.sourcePath).catch(() => null)
  if (
    currentPath !== snapshot.quiescedSource.realPath ||
    (await sourceFootprint(snapshot.quiescedSource.realPath)) !== snapshot.quiescedSource.footprint
  )
    throw new RuntimeError('LEGACY_DATABASE_SOURCE_CHANGED_DURING_HANDOVER')
}

/**
 * Re-opens a completed handover artifact without touching the legacy writer.
 * This is the recovery-drill check used before a production cutover: it proves
 * that the manifest still points at a private, readable, contract-compatible
 * backup, without pretending that a mutable SQLite file has a static hash.
 */
async function readHandoverManifest(manifestPath: string): Promise<LegacyDatabaseHandoverSnapshot> {
  if (!manifestPath) throw new RuntimeError('LEGACY_DATABASE_HANDOVER_MANIFEST_REQUIRED')
  const resolvedManifestPath = resolve(manifestPath)
  let snapshot: LegacyDatabaseHandoverSnapshot
  try {
    snapshot = snapshotFromUnknown(
      JSON.parse(await readFile(resolvedManifestPath, 'utf8')),
      resolvedManifestPath
    )
  } catch (error) {
    if (error instanceof RuntimeError) throw error
    throw new RuntimeError('LEGACY_DATABASE_HANDOVER_MANIFEST_INVALID')
  }
  const backupPath = resolve(snapshot.backupPath)
  const rollbackPath = resolve(snapshot.rollbackPath)
  if (
    backupPath === resolve(snapshot.sourcePath) ||
    rollbackPath === backupPath ||
    rollbackPath === resolve(snapshot.sourcePath) ||
    rollbackPath !== `${backupPath}.rollback.db`
  )
    throw new RuntimeError('LEGACY_DATABASE_HANDOVER_MANIFEST_INVALID')
  return { ...snapshot, backupPath, rollbackPath }
}

export async function verifyLegacyRollbackBaseline(input: {
  manifestPath: string
}): Promise<LegacyDatabaseHandoverSnapshot> {
  const snapshot = await readHandoverManifest(input.manifestPath)
  const rollbackPath = snapshot.rollbackPath
  const rollbackStat = await lstat(rollbackPath, { bigint: true }).catch(() => null)
  if (!rollbackStat?.isFile() || rollbackStat.isSymbolicLink())
    throw new RuntimeError('LEGACY_DATABASE_ROLLBACK_UNAVAILABLE')
  const sourceStat = await stat(snapshot.sourcePath, { bigint: true }).catch(() => null)
  const backupStat = await lstat(snapshot.backupPath, { bigint: true }).catch(() => null)
  if (
    rollbackStat.ino > 0n &&
    ((backupStat && rollbackStat.dev === backupStat.dev && rollbackStat.ino === backupStat.ino) ||
      (sourceStat && rollbackStat.dev === sourceStat.dev && rollbackStat.ino === sourceStat.ino))
  )
    throw new RuntimeError('LEGACY_DATABASE_ROLLBACK_INSECURE')
  const rollbackWritable = (rollbackStat.mode & 0o222n) !== 0n
  const rollbackShared = (rollbackStat.mode & 0o377n) !== 0n
  if (process.platform === 'win32' ? rollbackWritable : rollbackShared)
    throw new RuntimeError('LEGACY_DATABASE_ROLLBACK_INSECURE')
  if (
    rollbackStat.size !== BigInt(snapshot.rollbackSize) ||
    (await sha256File(rollbackPath)) !== snapshot.rollbackSha256
  )
    throw new RuntimeError('LEGACY_DATABASE_ROLLBACK_MISMATCH')
  const rollbackContract = await verifyLegacyBusinessDatabaseContract({ sourcePath: rollbackPath })
  if (
    rollbackContract.userVersion !== snapshot.userVersion ||
    JSON.stringify(rollbackContract.tables) !== JSON.stringify(snapshot.tables)
  )
    throw new RuntimeError('LEGACY_DATABASE_ROLLBACK_MISMATCH')
  return snapshot
}

export async function verifyLegacyDatabaseHandoverSnapshot(input: {
  manifestPath: string
}): Promise<LegacyDatabaseHandoverSnapshot> {
  const snapshot = await readHandoverManifest(input.manifestPath)
  const backupPath = snapshot.backupPath
  const backupStat = await lstat(backupPath, { bigint: true }).catch(() => null)
  if (backupStat?.isSymbolicLink()) throw new RuntimeError('LEGACY_DATABASE_BACKUP_INSECURE')
  if (!backupStat?.isFile() || backupStat.size <= 0n)
    throw new RuntimeError('LEGACY_DATABASE_BACKUP_UNAVAILABLE')
  const sourceRealPath = await realpath(snapshot.sourcePath).catch(() => null)
  if (sourceRealPath && sourceRealPath === (await realpath(backupPath)))
    throw new RuntimeError('LEGACY_DATABASE_BACKUP_INSECURE')
  const sourceStat = await stat(snapshot.sourcePath, { bigint: true }).catch(() => null)
  if (
    sourceStat &&
    backupStat.ino > 0n &&
    backupStat.dev === sourceStat.dev &&
    backupStat.ino === sourceStat.ino
  )
    throw new RuntimeError('LEGACY_DATABASE_BACKUP_INSECURE')
  if (process.platform !== 'win32' && (backupStat.mode & 0o077n) !== 0n)
    throw new RuntimeError('LEGACY_DATABASE_BACKUP_INSECURE')
  await verifyLegacyRollbackBaseline(input)
  const contract = await verifyLegacyBusinessDatabaseContract({ sourcePath: backupPath })
  // Handover may add TS-owned compatibility/archive tables after the initial
  // snapshot (notably the preserved Native Project Wiki archive). They must
  // not be mistaken for a post-cutover legacy schema drift.
  const legacyTables = contract.tables.filter(
    (table) =>
      !table.startsWith('ola_ts_') &&
      !table.startsWith('ola_native_wiki_') &&
      table !== 'ola_pending_session_queues' &&
      table !== 'cron_run_deliveries'
  )
  if (
    contract.userVersion !== snapshot.userVersion ||
    JSON.stringify(legacyTables) !== JSON.stringify(snapshot.tables)
  )
    throw new RuntimeError('LEGACY_DATABASE_BACKUP_MISMATCH')
  return snapshot
}

/** Copies the immutable pre-cutover baseline into a new, isolated writable directory. */
export async function createLegacyRollbackDrill(input: {
  manifestPath: string
  restoreDirectory: string
}): Promise<{
  restoredPath: string
  drillDirectory: string
  snapshot: LegacyDatabaseHandoverSnapshot
}> {
  if (!input.restoreDirectory) throw new RuntimeError('LEGACY_DATABASE_RESTORE_DIRECTORY_REQUIRED')
  const snapshot = await verifyLegacyRollbackBaseline({
    manifestPath: input.manifestPath
  })
  const restoreRoot = resolve(input.restoreDirectory)
  await mkdir(restoreRoot, { recursive: true, mode: 0o700 })
  const restoreStat = await lstat(restoreRoot)
  if (!restoreStat.isDirectory() || restoreStat.isSymbolicLink())
    throw new RuntimeError('LEGACY_DATABASE_RESTORE_DIRECTORY_UNSAFE')
  const drillDirectory = await mkdtemp(join(restoreRoot, 'ola-rollback-drill-'))
  const restoredPath = join(drillDirectory, 'data.db')
  await copyFile(snapshot.rollbackPath, restoredPath, fsConstants.COPYFILE_EXCL)
  await chmod(restoredPath, 0o600)
  const restored = await verifyLegacyBusinessDatabaseContract({ sourcePath: restoredPath })
  if (
    restored.userVersion !== snapshot.userVersion ||
    JSON.stringify(restored.tables) !== JSON.stringify(snapshot.tables) ||
    (await sha256File(restoredPath)) !== snapshot.rollbackSha256
  )
    throw new RuntimeError('LEGACY_DATABASE_ROLLBACK_RESTORE_MISMATCH')
  return { restoredPath, drillDirectory, snapshot }
}
