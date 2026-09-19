export const LATEST_BUSINESS_SCHEMA_VERSION = 2

const REQUIRED_COLUMNS = {
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
  ]
}

function columnsForTable(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name)
      .filter((name) => typeof name === 'string')
  )
}

function verifyLegacyBusinessTables(db) {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name)
  )
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tables.has(table)) throw new Error(`BUSINESS_SCHEMA_UNSUPPORTED:${table}`)
    const columns = columnsForTable(db, table)
    const missing = required.find((column) => !columns.has(column))
    if (missing) throw new Error(`BUSINESS_SCHEMA_UNSUPPORTED:${table}.${missing}`)
  }
  const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeyErrors.length) throw new Error('BUSINESS_SCHEMA_FOREIGN_KEY_FAILED')
}

/**
 * The native schema has no trustworthy PRAGMA user_version history. TS keeps
 * its own append-only migration ledger instead, so it can take ownership of a
 * verified backup without claiming that a legacy additive migration completed.
 */
export function migrateBusinessSchema(db) {
  verifyLegacyBusinessTables(db)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ola_ts_schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at INTEGER NOT NULL,
        description TEXT NOT NULL
      );
    `)
    const applied = new Set(
      db
        .prepare('SELECT version FROM ola_ts_schema_migrations ORDER BY version')
        .all()
        .map((row) => row.version)
    )
    for (let version = 1; version <= LATEST_BUSINESS_SCHEMA_VERSION; version++) {
      if (applied.has(version)) continue
      if (version === 1) {
        db.prepare(
          'INSERT INTO ola_ts_schema_migrations(version, applied_at, description) VALUES(?,?,?)'
        ).run(version, Date.now(), 'verified legacy business schema ownership')
      } else if (version === 2) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS ola_ts_sync_baselines_v2 (
            scope_hash TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            record_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            synced_at INTEGER NOT NULL,
            PRIMARY KEY(scope_hash, provider_id, domain, record_id)
          );
          CREATE TABLE IF NOT EXISTS ola_ts_sync_tombstones_v2 (
            scope_hash TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            record_id TEXT NOT NULL,
            deleted_at INTEGER NOT NULL,
            origin_device_id TEXT NOT NULL,
            PRIMARY KEY(scope_hash, provider_id, domain, record_id)
          );
          CREATE INDEX IF NOT EXISTS idx_ola_ts_sync_tombstones_scope
            ON ola_ts_sync_tombstones_v2(scope_hash, provider_id, deleted_at);
        `)
        db.prepare(
          'INSERT INTO ola_ts_schema_migrations(version, applied_at, description) VALUES(?,?,?)'
        ).run(version, Date.now(), 'workspace-scoped sync baseline and tombstones')
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the migration failure as the actionable error.
    }
    throw error
  }
}
