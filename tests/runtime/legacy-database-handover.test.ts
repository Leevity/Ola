import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createLegacyRollbackDrill,
  createLegacyDatabaseHandoverSnapshot,
  minimumLegacyHandoverFreeBytes,
  prepareLegacyHandoverBackupDirectory,
  verifyQuiescedLegacySourceUnchanged,
  verifyLegacyDatabaseHandoverSnapshot,
  verifyLegacyBusinessDatabaseContract
} from '../../src/runtime/storage/legacy-database-handover'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'
import {
  businessHandoverReadiness,
  handoverBusinessDatabase
} from '../../src/runtime/storage/business-handover-coordinator'
import {
  applyWorkspaceDrawBundle,
  captureWorkspaceDrawBundle,
  captureWorkspaceDrawState,
  commitWorkspaceDrawMerge
} from '../../src/runtime/storage/workspace-draw-sync'
import { mergeWorkspaceDrawBundles } from '../../src/runtime/storage/workspace-draw-merge'
import { runWorkspaceDrawSync } from '../../src/runtime/storage/workspace-draw-sync-run'
import { captureWorkspaceSyncState } from '../../src/runtime/storage/workspace-sync'
import { runWorkspaceSync } from '../../src/runtime/storage/workspace-sync-run'
import type { ProjectWikiDocument } from '../../src/shared/project-wiki'
import { WebDavProvider } from '../../src/main/sync/webdav-provider'
import type { WorkspaceSyncBundle } from '../../src/shared/sync-types'
import {
  hashSyncBundleContent,
  hashSyncRecordValue,
  workspaceSyncScopeHash
} from '../../src/shared/sync-bundle-contract'

const directories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function createFixture(): Promise<{ sourcePath: string; backupDirectory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ola-legacy-handover-'))
  directories.push(directory)
  const sourcePath = join(directory, 'data.db')
  const database = new DatabaseSync(sourcePath)
  database.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA user_version=7;
    CREATE TABLE ssh_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE ssh_connections (
      id TEXT PRIMARY KEY, group_id TEXT, name TEXT NOT NULL, host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'password', encrypted_password TEXT,
      private_key_path TEXT, encrypted_passphrase TEXT, startup_command TEXT,
      default_directory TEXT, proxy_jump TEXT, keep_alive_interval INTEGER DEFAULT 60,
      sort_order INTEGER NOT NULL DEFAULT 0, last_connected_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY (group_id) REFERENCES ssh_groups(id) ON DELETE SET NULL
    );
    CREATE TABLE app_migrations (key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, icon TEXT, mode TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL, project_id TEXT, working_folder TEXT,
      ssh_connection_id TEXT, plan_id TEXT, pinned INTEGER, plugin_id TEXT,
      external_chat_id TEXT, provider_id TEXT, model_id TEXT,
      model_selection_mode TEXT, model_source TEXT, workspace_id TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL,
      usage TEXT, sort_order INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, working_folder TEXT,
      ssh_connection_id TEXT, plugin_id TEXT, pinned INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      workspace_id TEXT NOT NULL, model_source TEXT
    );
    CREATE TABLE plans (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      title TEXT NOT NULL, status TEXT NOT NULL, file_path TEXT, content TEXT, spec_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE session_goals (
      session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      goal_id TEXT NOT NULL, objective TEXT NOT NULL, status TEXT NOT NULL,
      token_budget INTEGER, tokens_used INTEGER NOT NULL, time_used_seconds INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE session_goal_events (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      goal_id TEXT, event_type TEXT NOT NULL, message TEXT, metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule_kind TEXT NOT NULL,
      schedule_at INTEGER, schedule_every INTEGER, schedule_expr TEXT, schedule_tz TEXT,
      prompt TEXT NOT NULL, agent_id TEXT, model TEXT, model_source TEXT, working_folder TEXT,
      ssh_connection_id TEXT, session_id TEXT, source_session_title TEXT,
      source_project_id TEXT, source_project_name TEXT, source_provider_id TEXT,
      delivery_mode TEXT, delivery_target TEXT, plugin_id TEXT, plugin_chat_id TEXT,
      enabled INTEGER NOT NULL, delete_after_run INTEGER NOT NULL, max_iterations INTEGER NOT NULL,
      deleted_at INTEGER, last_fired_at INTEGER, fire_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, workspace_id TEXT NOT NULL
    );
    CREATE TABLE cron_runs (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT, tool_call_count INTEGER,
      output_summary TEXT, error TEXT, scheduled_for INTEGER, job_name_snapshot TEXT,
      prompt_snapshot TEXT, source_session_id_snapshot TEXT, source_session_title_snapshot TEXT,
      source_project_id_snapshot TEXT, source_project_name_snapshot TEXT,
      source_provider_id_snapshot TEXT, model_snapshot TEXT, model_source_snapshot TEXT,
      working_folder_snapshot TEXT, delivery_mode_snapshot TEXT, delivery_target_snapshot TEXT
    );
    CREATE TABLE cron_run_messages (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES cron_runs(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, usage TEXT, message_source TEXT,
      sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE cron_run_logs (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES cron_runs(id) ON DELETE CASCADE,
      timestamp INTEGER NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, sort_order INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL, subject TEXT NOT NULL, description TEXT NOT NULL, active_form TEXT,
      status TEXT NOT NULL, owner TEXT, blocks TEXT NOT NULL, blocked_by TEXT NOT NULL,
      metadata TEXT, sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE memory_roots (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, project_id TEXT, working_folder TEXT,
      ssh_connection_id TEXT, root_path TEXT NOT NULL, transport TEXT NOT NULL,
      owner_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, workspace_id TEXT NOT NULL
    );
    CREATE TABLE memory_stage1_outputs (
      id TEXT PRIMARY KEY, memory_root_id TEXT NOT NULL REFERENCES memory_roots(id),
      scope TEXT NOT NULL, source_session_id TEXT NOT NULL, source_updated_at INTEGER,
      raw_memory TEXT NOT NULL, rollout_summary TEXT NOT NULL, rollout_slug TEXT NOT NULL,
      fingerprint TEXT NOT NULL, status TEXT NOT NULL, usage_count INTEGER NOT NULL,
      last_usage_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_memory_stage1_unique
      ON memory_stage1_outputs(memory_root_id,source_session_id,fingerprint);
    CREATE TABLE memory_jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
      memory_root_id TEXT REFERENCES memory_roots(id), source_session_id TEXT,
      lease_owner TEXT, lease_expires_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT, started_at INTEGER, finished_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, workspace_id TEXT NOT NULL
    );
    CREATE TABLE memory_automation_entries (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, root_scope TEXT, memory_root_id TEXT,
      job_id TEXT, project_id TEXT, target TEXT NOT NULL, kind TEXT NOT NULL,
      content TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0, source_session_id TEXT,
      target_path TEXT, status TEXT NOT NULL, filter_reason TEXT, fingerprint TEXT NOT NULL,
      evidence_json TEXT, written_at INTEGER, error TEXT, before_content TEXT,
      after_content TEXT, appended_text TEXT, ssh_connection_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, undone_at INTEGER,
      workspace_id TEXT NOT NULL
    );
    CREATE TABLE memory_automation_rollups_v2 (
      workspace_id TEXT NOT NULL, scope TEXT NOT NULL, target TEXT NOT NULL,
      target_path TEXT NOT NULL, source_date TEXT NOT NULL, content_hash TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id,scope,target_path,source_date,content_hash)
    );
    CREATE TABLE memory_citation_usage (
      id TEXT PRIMARY KEY, memory_root_id TEXT NOT NULL REFERENCES memory_roots(id),
      scope TEXT NOT NULL, source_session_id TEXT, path TEXT NOT NULL,
      line INTEGER, citation_json TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE usage_events (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, request_started_at INTEGER,
      request_finished_at INTEGER, session_id TEXT, message_id TEXT, project_id TEXT,
      source_kind TEXT NOT NULL, provider_id TEXT, provider_name TEXT, provider_type TEXT,
      provider_builtin_id TEXT, provider_base_url TEXT, model_id TEXT, model_name TEXT,
      model_category TEXT, request_type TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
      billable_input_tokens INTEGER, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER, cache_read_tokens INTEGER, reasoning_tokens INTEGER,
      context_tokens INTEGER, input_price REAL, output_price REAL,
      cache_creation_price REAL, cache_hit_price REAL, input_cost_usd REAL,
      output_cost_usd REAL, cache_creation_cost_usd REAL, cache_hit_cost_usd REAL,
      total_cost_usd REAL, ttft_ms REAL, total_ms REAL, tps REAL,
      provider_response_id TEXT, request_debug_json TEXT, usage_raw_json TEXT,
      meta_json TEXT, workspace_id TEXT NOT NULL
    );
    CREATE TABLE usage_activity_daily_v2 (
      workspace_id TEXT NOT NULL, day TEXT NOT NULL, first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL, request_count INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
      total_cost_usd REAL NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, day)
    );
    CREATE TABLE usage_activity_daily_models_v2 (
      workspace_id TEXT NOT NULL, day TEXT NOT NULL, provider_id TEXT NOT NULL,
      provider_name TEXT, model_id TEXT NOT NULL, model_name TEXT,
      request_count INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
      total_cost_usd REAL NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, day, provider_id, model_id)
    );
    CREATE TABLE usage_activity_daily_providers_v2 (
      workspace_id TEXT NOT NULL, day TEXT NOT NULL, provider_id TEXT NOT NULL,
      provider_name TEXT, provider_type TEXT, provider_builtin_id TEXT,
      provider_base_url TEXT, request_count INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
      total_cost_usd REAL NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, day, provider_id)
    );
    CREATE TABLE draw_runs (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, provider_name TEXT NOT NULL,
      model_name TEXT NOT NULL, mode TEXT NOT NULL, meta_json TEXT,
      created_at INTEGER NOT NULL, is_generating INTEGER NOT NULL,
      images_json TEXT NOT NULL, error_json TEXT, updated_at INTEGER NOT NULL,
      workspace_id TEXT NOT NULL
    );
    CREATE TABLE agent_change_sets (
      run_id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_file_changes (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_change_sets(run_id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      tool_use_id TEXT, tool_name TEXT, file_path TEXT NOT NULL, transport TEXT NOT NULL,
      connection_id TEXT, op TEXT NOT NULL, status TEXT NOT NULL,
      before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      reverted_at INTEGER, sort_order INTEGER NOT NULL
    );
    INSERT INTO draw_runs VALUES
      ('draw-personal','Personal drawing','Provider','Model','image',NULL,1,0,'[]',NULL,1,'local-personal'),
      ('draw-team','Team drawing','Provider','Model','image',NULL,2,0,'[]',NULL,2,'team-a');
    CREATE TABLE sub_agent_history (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      sub_agent_id TEXT NOT NULL, tool_use_id TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
      updated_at INTEGER NOT NULL, sort_order INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      UNIQUE(session_id, tool_use_id)
    );
    CREATE TABLE runtime_tool_results (
      session_id TEXT NOT NULL, tool_use_id TEXT NOT NULL, run_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, status TEXT NOT NULL, content_json TEXT NOT NULL,
      is_error INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, tool_use_id)
    );
    CREATE TABLE runtime_jobs (
      job_id TEXT PRIMARY KEY, run_id TEXT, session_id TEXT,
      method TEXT NOT NULL, state TEXT NOT NULL, idempotency_key TEXT,
      lane_key TEXT, params_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT, error_message TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, finished_at INTEGER,
      workspace_id TEXT NOT NULL DEFAULT 'local-personal'
    );
    CREATE UNIQUE INDEX idx_runtime_jobs_idempotency
      ON runtime_jobs(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE runtime_job_events (
      job_id TEXT NOT NULL, seq INTEGER NOT NULL, payload_json TEXT NOT NULL,
      terminal INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      PRIMARY KEY (job_id, seq)
    );
    CREATE TABLE qq_wakeup_windows_v2 (
      workspace_id TEXT NOT NULL, plugin_id TEXT NOT NULL, open_id TEXT NOT NULL,
      period_key TEXT NOT NULL, source_message_id TEXT, source_timestamp INTEGER NOT NULL,
      sent_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, plugin_id, open_id, period_key)
    );
    CREATE TABLE wiki_documents (
      project_root TEXT PRIMARY KEY, document_json TEXT NOT NULL,
      generated_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE wiki_nodes (
      project_root TEXT NOT NULL, node_path TEXT NOT NULL, node_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (project_root, node_path)
    );
    CREATE TABLE wiki_file_snapshots (
      project_root TEXT NOT NULL, file_path TEXT NOT NULL, content_hash TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0, modified_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY (project_root, file_path)
    );
    CREATE TABLE wiki_generation_runs (
      id TEXT PRIMARY KEY, project_root TEXT NOT NULL, state TEXT NOT NULL,
      error_message TEXT, started_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE TABLE desktop_flows (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, flow_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'local-personal'
    );
    CREATE TABLE desktop_flow_steps (
      flow_id TEXT NOT NULL, step_id TEXT NOT NULL, sort_order INTEGER NOT NULL,
      step_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (flow_id, step_id)
    );
    CREATE TABLE desktop_flow_runs (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, state TEXT NOT NULL,
      error_message TEXT, started_at INTEGER NOT NULL, finished_at INTEGER
    );
    INSERT INTO memory_roots VALUES
      ('memory-personal','global',NULL,NULL,NULL,'/personal','local','personal-owner',1,1,'local-personal'),
      ('memory-team','global',NULL,NULL,NULL,'/team','local','team-owner',2,2,'team-a');
    INSERT INTO memory_stage1_outputs VALUES
      ('output-personal','memory-personal','global','session-1',1,'Personal detail','Personal summary','personal','fingerprint-personal','active',0,NULL,1,1),
      ('output-team','memory-team','global','team-session',2,'Team detail','Team summary','team','fingerprint-team','active',0,NULL,2,2);
    INSERT INTO memory_jobs (id,kind,status,memory_root_id,source_session_id,created_at,updated_at,workspace_id) VALUES
      ('job-personal','phase2','succeeded','memory-personal','session-1',1,1,'local-personal'),
      ('job-team','phase2','succeeded','memory-team','team-session',2,2,'team-a'),
      ('job-inconsistent','phase2','succeeded','memory-personal','team-session',3,3,'team-a');
    INSERT INTO memory_automation_entries
      (id,scope,root_scope,memory_root_id,target,kind,content,status,fingerprint,created_at,updated_at,workspace_id) VALUES
      ('entry-personal','main','global','memory-personal','global_memory','daily_context','Personal note','written','entry-personal',1,1,'local-personal'),
      ('entry-team','main','global','memory-team','global_memory','daily_context','Team note','written','entry-team',2,2,'team-a'),
      ('entry-inconsistent','main','global','memory-personal','global_memory','daily_context','Wrong owner','written','entry-inconsistent',3,3,'team-a');
    INSERT INTO memory_automation_rollups_v2 VALUES
      ('local-personal','main','global_memory','/personal','2026-09-17','personal-hash',1),
      ('team-a','main','global_memory','/team','2026-09-17','team-hash',2);
    INSERT INTO memory_citation_usage (id,memory_root_id,scope,path,created_at) VALUES
      ('citation-personal','memory-personal','global','/personal/MEMORY.md',1),
      ('citation-team','memory-team','global','/team/MEMORY.md',2);
    INSERT INTO sessions VALUES ('session-1', 'Legacy', NULL, 'chat', 1, 1, 1, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 'inherit', NULL, 'local-personal');
    INSERT INTO sub_agent_history VALUES
      ('history-personal','session-1','sub-agent','tool-a','Agent','completed',2,3,3,1,'{"private":"personal"}');
    INSERT INTO runtime_tool_results VALUES
      ('session-1','tool-a','run-a','Read','completed','{"text":"personal"}',0,1,2);
    INSERT INTO usage_events (id,created_at,session_id,source_kind,provider_id,model_id,input_tokens,output_tokens,workspace_id) VALUES
      ('usage-personal',1000,'session-1','chat','provider-a','model-a',10,2,'local-personal'),
      ('usage-team',1000,NULL,'chat','provider-a','model-a',20,3,'team-a');
    INSERT INTO usage_activity_daily_v2 VALUES
      ('local-personal','1970-01-01',1000,1000,1,10,2,0,0,0,0,1000),
      ('team-a','1970-01-01',1000,1000,1,20,3,0,0,0,0,1000);
    INSERT INTO usage_activity_daily_models_v2 VALUES
      ('local-personal','1970-01-01','provider-a',NULL,'model-a',NULL,1,10,2,0,0,0,0,1000),
      ('team-a','1970-01-01','provider-a',NULL,'model-a',NULL,1,20,3,0,0,0,0,1000);
    INSERT INTO usage_activity_daily_providers_v2 VALUES
      ('local-personal','1970-01-01','provider-a',NULL,NULL,NULL,NULL,1,10,2,0,0,0,0,1000),
      ('team-a','1970-01-01','provider-a',NULL,NULL,NULL,NULL,1,20,3,0,0,0,0,1000);
    INSERT INTO messages VALUES ('message-1', 'session-1', 'user', 'Preserved', NULL, 1, NULL, 1);
    INSERT INTO cron_jobs (
      id,name,schedule_kind,schedule_every,schedule_tz,prompt,session_id,delivery_mode,
      enabled,delete_after_run,max_iterations,fire_count,created_at,updated_at,workspace_id
    ) VALUES ('cron-1','Legacy cron','every',1000,'UTC','Preserved','session-1','none',1,0,5,0,1,1,'local-personal');
    INSERT INTO cron_runs VALUES ('cron-run-1', 'cron-1', 1, 2, 'success', 1, 'Done', NULL, 1, 'Legacy cron', 'Preserved', 'session-1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'none', NULL);
    INSERT INTO cron_run_messages VALUES ('cron-message-1', 'cron-run-1', 'assistant', 'Done', NULL, NULL, 1, 2);
    INSERT INTO cron_run_logs VALUES ('cron-log-1', 'cron-run-1', 2, 'end', 'success', 1);
  `)
  database.close()
  return { sourcePath, backupDirectory: join(directory, 'handover-backups') }
}

describe('legacy database handover snapshot', () => {
  it('reports a read-only blocker before promotion when the source is unavailable', async () => {
    const readiness = await businessHandoverReadiness({
      sourcePath: join(tmpdir(), 'ola-missing-business-database.db')
    })
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toContain('LEGACY_DATABASE_UNAVAILABLE')
  })

  it('reports readiness for a valid legacy business database without creating a snapshot', async () => {
    const fixture = await createFixture()
    const readiness = await businessHandoverReadiness({ sourcePath: fixture.sourcePath })
    expect(readiness).toEqual({ ready: true })
    await expect(stat(join(fixture.backupDirectory, 'data.db'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('accepts the current Native Project Wiki schema and normalizes only the handover copy', async () => {
    const fixture = await createFixture()
    const source = new DatabaseSync(fixture.sourcePath)
    source.exec(`
      DROP TABLE wiki_generation_runs;
      DROP TABLE wiki_documents;
      CREATE TABLE wiki_documents (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
        slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft', content_markdown TEXT NOT NULL DEFAULT '',
        generation_mode TEXT NOT NULL DEFAULT 'full', last_generated_commit_id TEXT,
        parent_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0,
        is_leaf INTEGER NOT NULL DEFAULT 1, source_files_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE wiki_generation_runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mode TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running', base_commit_id TEXT, head_commit_id TEXT,
        changed_files_json TEXT NOT NULL DEFAULT '[]', affected_documents_json TEXT NOT NULL DEFAULT '[]',
        output_summary TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO wiki_documents
        (id, project_id, name, slug, description, status, content_markdown,
         generation_mode, created_at, updated_at)
      VALUES
        ('native-doc-1', 'project-1', 'Native document', 'native-document',
         'preserved during handover', 'published', '# Native Wiki', 'full', 10, 20);
      INSERT INTO wiki_generation_runs
        (id, project_id, mode, status, output_summary, created_at, updated_at)
      VALUES
        ('native-run-1', 'project-1', 'full', 'succeeded', 'done', 10, 20);
    `)
    source.close()
    await expect(businessHandoverReadiness({ sourcePath: fixture.sourcePath })).resolves.toEqual({
      ready: true,
      warning: 'LEGACY_NATIVE_WIKI_DATA_WILL_BE_PRESERVED_IN_TS_ARCHIVE'
    })
    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      sourcePath: fixture.sourcePath,
      backupDirectory: fixture.backupDirectory
    })
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    directories.push(snapshot.backupPath, snapshot.rollbackPath, snapshot.manifestPath)
    try {
      const document: ProjectWikiDocument = {
        id: 'ts-wiki',
        projectRoot: '/projects/native-schema',
        generatedAt: 10,
        fileCount: 1,
        nodes: [{ path: 'index.ts', kind: 'file', size: 1, modifiedAt: 10 }]
      }
      await expect(repository.saveWikiDocument(document, 'local-personal', 11)).resolves.toBe(true)
      await expect(
        repository.wikiDocument(document.projectRoot, 'local-personal')
      ).resolves.toEqual(document)
      await expect(repository.legacyProjectWikiCounts()).resolves.toEqual({
        documents: 1,
        generationRuns: 1
      })
      const promoted = new DatabaseSync(snapshot.backupPath)
      expect(
        promoted
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ola_native_wiki_%'"
          )
          .all()
      ).toHaveLength(2)
      expect(
        promoted
          .prepare('SELECT id, project_id, content_markdown FROM ola_native_wiki_documents_v1')
          .all()
      ).toEqual([
        { id: 'native-doc-1', project_id: 'project-1', content_markdown: '# Native Wiki' }
      ])
      expect(
        promoted
          .prepare('SELECT id, project_id, status FROM ola_native_wiki_generation_runs_v1')
          .all()
      ).toEqual([{ id: 'native-run-1', project_id: 'project-1', status: 'succeeded' }])
      promoted.close()
    } finally {
      await repository.close()
    }
  })

  it('preserves legacy Project Wiki data in the TS-owned archive during handover', async () => {
    const fixture = await createFixture()
    const source = new DatabaseSync(fixture.sourcePath)
    source.exec(`
      DROP TABLE wiki_generation_runs;
      DROP TABLE wiki_documents;
      CREATE TABLE wiki_documents (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
        slug TEXT NOT NULL, content_markdown TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE wiki_generation_runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mode TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO wiki_documents VALUES ('native-doc', 'project-1', 'Doc', 'doc', '# Doc', 1, 1);
    `)
    source.close()
    let quiesced = false

    const result = await handoverBusinessDatabase({
      ...fixture,
      quiesceLegacyWriter: async () => {
        quiesced = true
      }
    })
    expect(quiesced).toBe(true)
    await expect(result.repository.legacyProjectWikiCounts()).resolves.toEqual({
      documents: 1,
      generationRuns: 0
    })
    await result.repository.close()
    directories.push(
      result.snapshot.backupPath,
      result.snapshot.rollbackPath,
      result.snapshot.manifestPath
    )
  })

  it('rejects a symlinked backup directory during read-only preflight', async () => {
    const fixture = await createFixture()
    const linkedDirectory = join(dirname(fixture.backupDirectory), 'linked-backups')
    await symlink(fixture.backupDirectory, linkedDirectory)
    directories.push(linkedDirectory)
    const readiness = await businessHandoverReadiness({
      sourcePath: fixture.sourcePath,
      backupDirectory: linkedDirectory
    })
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toContain('LEGACY_DATABASE_BACKUP_DIRECTORY')
  })

  it('rejects a Native database missing the migration ledger before parking its writer', async () => {
    const fixture = await createFixture()
    const source = new DatabaseSync(fixture.sourcePath)
    source.exec('DROP TABLE app_migrations')
    source.close()
    let parked = false
    await expect(
      handoverBusinessDatabase({
        ...fixture,
        quiesceLegacyWriter: async () => {
          parked = true
        }
      })
    ).rejects.toThrow('LEGACY_DATABASE_SCHEMA_UNSUPPORTED:app_migrations')
    expect(parked).toBe(false)
  })

  it('rejects insufficient backup capacity before writing a snapshot', async () => {
    const fixture = await createFixture()
    const sourceSize = (await stat(fixture.sourcePath)).size
    expect(await minimumLegacyHandoverFreeBytes(fixture.sourcePath)).toBe(
      BigInt(sourceSize) * 4n + 64n * 1024n * 1024n
    )
    await writeFile(`${fixture.sourcePath}-wal`, Buffer.alloc(3))
    expect(await minimumLegacyHandoverFreeBytes(fixture.sourcePath)).toBe(
      BigInt(sourceSize + 3) * 4n + 64n * 1024n * 1024n
    )
    await expect(
      prepareLegacyHandoverBackupDirectory(fixture.backupDirectory, 1n << 120n)
    ).rejects.toThrow('LEGACY_DATABASE_BACKUP_SPACE_INSUFFICIENT')
    expect(await readdir(fixture.backupDirectory)).toEqual([])
  })

  it('does not park Native when the backup destination fails the private-directory preflight', async () => {
    const fixture = await createFixture()
    await symlink(dirname(fixture.sourcePath), fixture.backupDirectory)
    let parked = false
    await expect(
      handoverBusinessDatabase({
        ...fixture,
        quiesceLegacyWriter: async () => {
          parked = true
        }
      })
    ).rejects.toThrow('LEGACY_DATABASE_BACKUP_DIRECTORY_UNSAFE')
    expect(parked).toBe(false)
    await rm(fixture.backupDirectory)
    await mkdir(fixture.backupDirectory, { mode: 0o755 })
    await chmod(fixture.backupDirectory, 0o755)
    await expect(
      handoverBusinessDatabase({
        ...fixture,
        quiesceLegacyWriter: async () => {
          parked = true
        }
      })
    ).rejects.toThrow('LEGACY_DATABASE_BACKUP_DIRECTORY_UNSAFE')
    expect(parked).toBe(false)
    await expect(
      handoverBusinessDatabase({
        ...fixture,
        backupDirectory: join(fixture.sourcePath, 'not-a-directory'),
        quiesceLegacyWriter: async () => {
          parked = true
        }
      })
    ).rejects.toThrow()
    expect(parked).toBe(false)
  })

  it('rechecks the backup destination after Native is parked', async () => {
    const fixture = await createFixture()
    let parked = false
    await expect(
      handoverBusinessDatabase({
        ...fixture,
        quiesceLegacyWriter: async () => {
          parked = true
          await rm(fixture.backupDirectory, { recursive: true })
          await symlink(dirname(fixture.sourcePath), fixture.backupDirectory)
        }
      })
    ).rejects.toThrow('LEGACY_DATABASE_BACKUP_DIRECTORY_UNSAFE')
    expect(parked).toBe(true)
  })

  it('repairs historical message ordering only in the promoted TS copy', async () => {
    const fixture = await createFixture()
    const source = new DatabaseSync(fixture.sourcePath)
    source.exec(`
      INSERT INTO sessions VALUES
        ('team-session','Team',NULL,'chat',2,2,0,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,'inherit',NULL,'team-a');
      INSERT INTO messages VALUES
        ('team-assistant','team-session','assistant','answer',NULL,2,NULL,7),
        ('team-user','team-session','user','question',NULL,2,NULL,7);
    `)
    source.close()

    const handover = await handoverBusinessDatabase({
      ...fixture,
      quiesceLegacyWriter: async () => undefined
    })
    try {
      const promoted = await handover.repository.messages<{
        id: string
        sort_order: number
      }>('team-session', 'team-a')
      expect(promoted.map(({ id, sort_order }) => [id, sort_order])).toEqual([
        ['team-user', 0],
        ['team-assistant', 1]
      ])
      expect(
        (
          await handover.repository.messages<{ id: string; sort_order: number }>(
            'session-1',
            'local-personal'
          )
        ).map(({ sort_order }) => sort_order)
      ).toEqual([0])
      expect(await handover.repository.normalizeMessageSortOrders()).toEqual({
        repairedSessions: 0,
        repairedMessages: 0
      })
      await expect(
        verifyLegacyDatabaseHandoverSnapshot({ manifestPath: handover.snapshot.manifestPath })
      ).resolves.toMatchObject({ backupPath: handover.snapshot.backupPath })
      const laterDrill = await createLegacyRollbackDrill({
        manifestPath: handover.snapshot.manifestPath,
        restoreDirectory: fixture.backupDirectory
      })
      const restored = new DatabaseSync(laterDrill.restoredPath, { readOnly: true })
      try {
        expect(
          restored.prepare('SELECT sort_order FROM messages WHERE id=?').get('message-1')
        ).toEqual({ sort_order: 1 })
      } finally {
        restored.close()
      }
      for (const path of [fixture.sourcePath, handover.snapshot.rollbackPath]) {
        const original = new DatabaseSync(path, { readOnly: true })
        expect(
          original.prepare('SELECT sort_order FROM messages WHERE id=?').get('message-1')
        ).toEqual({ sort_order: 1 })
        expect(
          original.prepare('SELECT sort_order FROM messages WHERE id=?').get('team-user')
        ).toEqual({ sort_order: 7 })
        original.close()
      }
    } finally {
      await handover.repository.close()
    }
  })

  it('rejects promotion if a legacy writer resumes during TS copy preparation', async () => {
    const fixture = await createFixture()
    const originalNormalize = BusinessRepository.prototype.normalizeMessageSortOrders
    const spy = vi
      .spyOn(BusinessRepository.prototype, 'normalizeMessageSortOrders')
      .mockImplementation(async function (this: BusinessRepository) {
        const result = await originalNormalize.call(this)
        const legacy = new DatabaseSync(fixture.sourcePath)
        try {
          legacy.prepare('UPDATE sessions SET title=? WHERE id=?').run('Late write', 'session-1')
        } finally {
          legacy.close()
        }
        return result
      })
    try {
      await expect(
        handoverBusinessDatabase({
          ...fixture,
          quiesceLegacyWriter: async () => undefined
        })
      ).rejects.toThrow('LEGACY_DATABASE_SOURCE_CHANGED_DURING_HANDOVER')
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })

  it('continues workspace-scoped agent change journals after handover', async () => {
    const fixture = await createFixture()
    const source = new DatabaseSync(fixture.sourcePath)
    source.exec(`
      INSERT INTO sessions VALUES
        ('team-session','Team',NULL,'chat',2,2,0,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,'inherit',NULL,'team-a');
      INSERT INTO agent_change_sets VALUES
        ('native-team-run','team-session','team-a','assistant-1','open',2,2);
      INSERT INTO agent_file_changes
        (id,run_id,session_id,file_path,transport,op,status,before_json,after_json,created_at,sort_order)
      VALUES
        ('native-change','native-team-run','team-session','/tmp/native-team.txt','local','create','open',
         '{"exists":false,"hash":null,"size":0}',
         '{"exists":true,"text":"team","hash":null,"size":4}',2,0);
    `)
    source.close()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      expect(await repository.agentChangeSet('native-team-run', 'local-personal')).toBeNull()
      expect(await repository.agentChangeSetsBySession('team-session', 'team-a')).toHaveLength(1)
      await expect(
        repository.agentChangeSetsBySession('team-session', 'local-personal')
      ).rejects.toThrow('BUSINESS_AGENT_CHANGE_WORKSPACE_MISMATCH')
      expect(await repository.agentChangeSet('native-team-run', 'team-a')).toMatchObject({
        changes: [{ id: 'native-change', after: { text: 'team' } }]
      })
      const change = {
        id: 'next-change',
        runId: 'native-team-run',
        sessionId: 'team-session',
        filePath: '/tmp/next-team.txt',
        transport: 'local' as const,
        op: 'modify' as const,
        status: 'open' as const,
        before: { exists: true, hash: null, size: 1 },
        after: { exists: true, hash: null, size: 2 },
        createdAt: 3
      }
      await expect(
        repository.appendAgentFileChange({
          runId: 'native-team-run',
          workspaceId: 'local-personal',
          sessionId: 'team-session',
          assistantMessageId: 'assistant-1',
          change,
          now: 3
        })
      ).rejects.toThrow('BUSINESS_AGENT_CHANGE_WORKSPACE_MISMATCH')
      await expect(
        repository.appendAgentFileChange({
          runId: 'native-team-run',
          workspaceId: 'local-personal',
          sessionId: 'session-1',
          assistantMessageId: 'assistant-1',
          change: { ...change, sessionId: 'session-1' },
          now: 3
        })
      ).rejects.toThrow('BUSINESS_AGENT_CHANGE_WORKSPACE_MISMATCH')
      expect(
        await repository.appendAgentFileChange({
          runId: 'native-team-run',
          workspaceId: 'team-a',
          sessionId: 'team-session',
          assistantMessageId: 'assistant-1',
          change,
          now: 3
        })
      ).toBe(true)
      expect((await repository.agentChangeSet('native-team-run', 'team-a'))?.changes).toHaveLength(
        2
      )
      expect(
        await repository.markAgentFileChangeReverted({
          runId: 'native-team-run',
          workspaceId: 'local-personal',
          changeId: 'native-change',
          revertedAt: 4
        })
      ).toBe(false)
      expect(
        await repository.markAgentFileChangeReverted({
          runId: 'native-team-run',
          workspaceId: 'team-a',
          changeId: 'native-change',
          revertedAt: 4
        })
      ).toBe(true)
      expect(await repository.recomputeAgentChangeSet('native-team-run', 'team-a', 5)).toBe(true)
      expect(await repository.agentChangeSet('native-team-run', 'team-a')).toMatchObject({
        status: 'open',
        changes: [{ status: 'reverted' }, { status: 'open' }]
      })
    } finally {
      await repository.close()
    }
  })

  it('continues workspace-scoped runtime jobs and event replay after Native handover', async () => {
    const fixture = await createFixture()
    const source = new DatabaseSync(fixture.sourcePath)
    source.exec(`
      INSERT INTO sessions VALUES
        ('team-session','Team',NULL,'chat',2,2,0,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,'inherit',NULL,'team-a');
      INSERT INTO runtime_jobs
        (job_id,run_id,session_id,method,state,idempotency_key,lane_key,params_json,created_at,updated_at,workspace_id)
      VALUES
        ('native-team-job','native-run','team-session','agent/run','running','native-key','team-session','{}',2,2,'team-a');
      INSERT INTO runtime_job_events VALUES ('native-team-job',1,'{"type":"native"}',0,2);
    `)
    source.close()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      expect(await repository.runtimeJob('native-team-job', 'local-personal')).toBeNull()
      expect(await repository.runtimeJobEvents('native-team-job', 'local-personal')).toEqual([])
      expect(await repository.runtimeJob('native-team-job', 'team-a')).toMatchObject({
        workspaceId: 'team-a',
        state: 'running'
      })
      expect(await repository.runtimeJobEvents('native-team-job', 'team-a')).toMatchObject([
        { seq: 1, terminal: false }
      ])
      await expect(
        repository.submitRuntimeJob({
          jobId: 'spoofed',
          workspaceId: 'local-personal',
          sessionId: 'team-session',
          method: 'agent/run',
          paramsJson: '{}',
          createdAt: 3
        })
      ).rejects.toThrow('BUSINESS_RUNTIME_JOB_SESSION_WORKSPACE_MISMATCH')
      const personal = await repository.submitRuntimeJob({
        jobId: 'personal-job',
        workspaceId: 'local-personal',
        sessionId: 'session-1',
        idempotencyKey: 'native-key',
        method: 'agent/run',
        paramsJson: '{}',
        createdAt: 3
      })
      expect(personal.accepted).toBe(true)
      expect(
        await repository.submitRuntimeJob({
          jobId: 'duplicate',
          workspaceId: 'local-personal',
          sessionId: 'session-1',
          idempotencyKey: 'native-key',
          method: 'agent/run',
          paramsJson: '{}',
          createdAt: 4
        })
      ).toMatchObject({ accepted: false, duplicate: true, job: { jobId: 'personal-job' } })
      expect(await repository.runtimeJobs('local-personal')).toHaveLength(1)
      expect(await repository.runtimeJobs('team-a')).toHaveLength(1)
      expect(await repository.cancelRuntimeJob('native-team-job', 'local-personal', 5)).toBeNull()
      expect(
        await repository.setRuntimeJobState({
          jobId: 'native-team-job',
          workspaceId: 'team-a',
          state: 'succeeded',
          updatedAt: 6
        })
      ).toMatchObject({ state: 'succeeded', finishedAt: 6 })
      await expect(
        repository.appendRuntimeJobEvent({
          jobId: 'native-team-job',
          workspaceId: 'local-personal',
          seq: 2,
          payloadJson: '{}',
          terminal: true,
          createdAt: 7
        })
      ).rejects.toThrow('BUSINESS_RUNTIME_JOB_NOT_FOUND')
      expect(
        await repository.appendRuntimeJobEvent({
          jobId: 'native-team-job',
          workspaceId: 'team-a',
          seq: 2,
          payloadJson: '{"type":"done"}',
          terminal: true,
          createdAt: 7
        })
      ).toBe(true)
      expect(await repository.runtimeJobEvents('native-team-job', 'team-a', 1)).toMatchObject([
        { seq: 2, terminal: true }
      ])
      expect(await repository.reapStaleRuntimeJobs(70_000, 60_000)).toMatchObject({
        reaped: 1,
        cutoffAt: 10_000
      })
      expect(await repository.runtimeJob('personal-job', 'local-personal')).toMatchObject({
        state: 'failed',
        errorCode: 'stale_job'
      })
      expect(await repository.runtimeJob('native-team-job', 'team-a')).toMatchObject({
        state: 'succeeded'
      })
    } finally {
      await repository.close()
    }
  })

  it('keeps TS runtime tool results scoped to the persisted session', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await expect(
        repository.runtimeToolResults('session-1', 'team-a', ['tool-a'])
      ).rejects.toThrow('BUSINESS_TOOL_RESULT_SESSION_NOT_FOUND')
      await expect(
        repository.runtimeToolResults('session-1', 'local-personal', ['tool-a'])
      ).resolves.toEqual([
        expect.objectContaining({ toolUseId: 'tool-a', contentJson: '{"text":"personal"}' })
      ])
      const next = {
        workspaceId: 'local-personal',
        sessionId: 'session-1',
        toolUseId: 'tool-b',
        runId: 'run-b',
        toolName: 'Read',
        status: 'completed',
        contentJson: '{"text":"new"}',
        isError: false,
        startedAt: 3,
        completedAt: 4
      }
      await expect(
        repository.upsertRuntimeToolResult({ ...next, workspaceId: 'team-a' })
      ).rejects.toThrow('BUSINESS_TOOL_RESULT_SESSION_NOT_FOUND')
      await expect(repository.upsertRuntimeToolResult(next)).resolves.toBe(true)
      await expect(
        repository.runtimeToolResults('session-1', 'local-personal', ['tool-b'])
      ).resolves.toEqual([expect.objectContaining({ toolUseId: 'tool-b' })])
    } finally {
      await repository.close()
    }
  })

  it('keeps TS sub-agent snapshots bound to persisted session ownership', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await expect(repository.subAgentHistoryIndex('session-1', 'team-a')).rejects.toThrow(
        'BUSINESS_SUB_AGENT_SESSION_NOT_FOUND'
      )
      await expect(repository.subAgentHistoryIndex('session-1', 'local-personal')).resolves.toEqual(
        [expect.objectContaining({ id: 'history-personal', snapshotJson: null })]
      )
      await expect(
        repository.subAgentHistoryPage({
          sessionId: 'session-1',
          workspaceId: 'local-personal'
        })
      ).resolves.toMatchObject({
        items: [expect.objectContaining({ snapshotJson: '{"private":"personal"}' })]
      })
      const item = {
        id: 'history-new',
        sessionId: 'session-1',
        subAgentId: 'sub-agent',
        toolUseId: 'tool-b',
        name: 'Agent',
        status: 'completed' as const,
        startedAt: 4,
        completedAt: 5,
        updatedAt: 5,
        sortOrder: 2,
        snapshotJson: '{"private":"new"}'
      }
      await expect(repository.applySubAgentHistory(item, 'team-a')).rejects.toThrow(
        'BUSINESS_SUB_AGENT_SESSION_NOT_FOUND'
      )
      await expect(repository.applySubAgentHistory(item, 'local-personal')).resolves.toBe(1)
      await expect(
        repository.replaceSubAgentHistory({
          sessionId: 'session-1',
          workspaceId: 'team-a',
          items: []
        })
      ).rejects.toThrow('BUSINESS_SUB_AGENT_SESSION_NOT_FOUND')
      await expect(
        repository.subAgentHistoryPage({
          sessionId: 'session-1',
          workspaceId: 'local-personal'
        })
      ).resolves.toMatchObject({
        items: [
          expect.objectContaining({ id: 'history-new' }),
          expect.objectContaining({ id: 'history-personal' })
        ]
      })
    } finally {
      await repository.close()
    }
  })

  it('keeps TS-owned draw history inside its workspace after handover', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await expect(repository.drawRuns('team-a')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-team', workspace_id: 'team-a' })
      ])
      await expect(
        repository.saveDrawRun({
          id: 'draw-team',
          workspaceId: 'local-personal',
          prompt: 'Spoof',
          providerName: 'Provider',
          modelName: 'Model',
          createdAt: 3,
          isGenerating: false,
          imagesJson: '[]',
          updatedAt: 3
        })
      ).rejects.toThrow('BUSINESS_DRAW_WORKSPACE_MISMATCH')
      await expect(
        repository.saveDrawRun({
          id: 'draw-new',
          workspaceId: 'team-a',
          prompt: 'New drawing',
          providerName: 'Provider',
          modelName: 'Model',
          createdAt: 3,
          isGenerating: false,
          imagesJson: '[]',
          updatedAt: 3
        })
      ).resolves.toBe(true)
      await expect(repository.deleteDrawRun('draw-new', 'local-personal')).resolves.toBe(false)
      await expect(repository.clearDrawRuns('local-personal')).resolves.toBe(1)
      await expect(repository.drawRuns('team-a')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-new' }),
        expect.objectContaining({ id: 'draw-team' })
      ])
    } finally {
      await repository.close()
    }
  })

  it('captures and reapplies workspace-owned draw rows from a real Native handover', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    const scope = {
      accountId: 'account-a',
      apiBaseUrl: 'https://ola.example.invalid',
      workspaceId: 'team-a'
    }
    const authorize = async () => undefined
    try {
      const bundle = await captureWorkspaceDrawBundle({
        repository,
        scope,
        providerId: 'webdav',
        deviceId: 'device-a',
        appVersion: '1.0.5',
        createdAt: 10,
        authorize
      })
      expect(bundle.records.map((record) => record.recordId)).toEqual(['draw-team'])
      expect(bundle.records[0].value).toMatchObject({ row: { workspace_id: 'team-a' } })
      expect(await repository.deleteDrawRun('draw-team', 'team-a')).toBe(true)
      await expect(
        applyWorkspaceDrawBundle({ repository, scope, bundle, authorize })
      ).resolves.toEqual({ saved: 1, deleted: 0 })
      await expect(repository.drawRuns('local-personal')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-personal' })
      ])
      const forged = structuredClone(bundle)
      forged.records[0].recordId = 'draw-personal'
      const forgedValue = forged.records[0].value as {
        row: { id: string }
      }
      forgedValue.row.id = 'draw-personal'
      forged.records[0].hash = hashSyncRecordValue(forgedValue)
      const { contentHash: _forgedHash, ...forgedManifest } = forged.manifest
      forged.manifest.contentHash = hashSyncBundleContent(
        forgedManifest,
        forged.records,
        forged.tombstones
      )
      await expect(
        applyWorkspaceDrawBundle({ repository, scope, bundle: forged, authorize })
      ).rejects.toThrow('BUSINESS_DRAW_WORKSPACE_MISMATCH')
      await expect(repository.drawRuns('local-personal')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-personal' })
      ])
      const deleteBundle = structuredClone(bundle)
      deleteBundle.records = []
      deleteBundle.tombstones = [
        {
          domain: 'db:draw_runs',
          recordId: 'draw-team',
          deletedAt: 11,
          originDeviceId: 'device-a',
          workspaceId: 'team-a'
        }
      ]
      deleteBundle.manifest.domains = {}
      deleteBundle.manifest.tombstones = 1
      const { contentHash: _hash, ...manifestBase } = deleteBundle.manifest
      deleteBundle.manifest.contentHash = hashSyncBundleContent(
        manifestBase,
        deleteBundle.records,
        deleteBundle.tombstones
      )
      await expect(
        applyWorkspaceDrawBundle({ repository, scope, bundle: deleteBundle, authorize })
      ).resolves.toEqual({ saved: 0, deleted: 1 })
      await expect(repository.drawRuns('team-a')).resolves.toEqual([])
      await expect(repository.drawRuns('local-personal')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-personal' })
      ])
    } finally {
      await repository.close()
    }
  })

  it('captures and commits the full workspace-owned business sync slice', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    const scope = {
      accountId: 'account-a',
      apiBaseUrl: 'https://ola.example.invalid',
      workspaceId: 'team-a'
    }
    const transport = {
      downloadWorkspace: async () => ({
        bundle: null,
        etag: null,
        lastModified: null,
        updatedAt: null
      }),
      uploadWorkspace: async (_config: unknown, _scope: unknown, bundle: WorkspaceSyncBundle) => ({
        bundle,
        etag: 'strong-etag',
        lastModified: null,
        updatedAt: Date.now()
      })
    }
    try {
      const result = await runWorkspaceSync({
        repository,
        transport,
        config: {
          displayName: 'test',
          serverUrl: 'https://dav.example.invalid',
          username: 'u',
          password: 'p',
          remoteDir: 'ola',
          autoSyncEnabled: false,
          syncIntervalMinutes: 30,
          backupRetention: 1
        },
        scope,
        providerId: 'webdav',
        deviceId: 'device-a',
        appVersion: '1.0.5',
        createdAt: 10,
        authorize: async () => undefined
      })
      expect(result.status).toBe('success')
      await repository.saveWikiDocument(
        {
          id: 'wiki-team',
          projectRoot: '/team-project',
          generatedAt: 11,
          fileCount: 1,
          nodes: [
            {
              path: 'src/index.ts',
              kind: 'file',
              size: 10,
              modifiedAt: 11,
              hash: 'team-wiki-hash',
              language: 'typescript'
            }
          ]
        },
        'team-a',
        11
      )
      await repository.recordQqWakeupSource({
        workspaceId: 'team-a',
        pluginId: 'qq',
        openId: 'user-a',
        sourceMessageId: 'message-a',
        sourceTimestamp: 11,
        now: 11
      })
      const captured = await captureWorkspaceSyncState({
        repository,
        scope,
        providerId: 'webdav',
        deviceId: 'device-a',
        appVersion: '1.0.5',
        createdAt: 11,
        authorize: async () => undefined
      })
      expect(captured.bundle.records.length).toBeGreaterThan(10)
      expect(
        captured.bundle.records.every(
          (record) =>
            record.workspaceId === 'team-a' ||
            (record.value as { row: { workspace_id?: string } }).row.workspace_id === 'team-a'
        )
      ).toBe(true)
      expect(captured.bundle.records.some((record) => record.domain === 'db:draw_runs')).toBe(true)
      expect(captured.bundle.records.some((record) => record.domain === 'db:usage_events')).toBe(
        true
      )
      expect(captured.bundle.records.some((record) => record.domain === 'db:wiki_documents')).toBe(
        true
      )
      expect(
        captured.bundle.records.some((record) => record.domain === 'db:qq_wakeup_windows_v2')
      ).toBe(true)
    } finally {
      await repository.close()
    }
  })

  it('rolls back a whole draw sync batch when a later row crosses workspace ownership', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    const draw = (id: string) => ({
      id,
      workspaceId: 'team-a',
      prompt: id,
      providerName: 'Provider',
      modelName: 'Model',
      createdAt: 3,
      isGenerating: false,
      imagesJson: '[]',
      updatedAt: 3
    })
    try {
      await expect(
        repository.applyDrawSyncBatch({
          workspaceId: 'team-a',
          records: [draw('draw-new'), draw('draw-personal')],
          deletedIds: ['draw-team']
        })
      ).rejects.toThrow('BUSINESS_DRAW_WORKSPACE_MISMATCH')
      await expect(repository.drawRuns('team-a')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-team' })
      ])
      await expect(repository.drawRuns('local-personal')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-personal' })
      ])
    } finally {
      await repository.close()
    }
  })

  it('persists scoped sync baseline and tombstones across TS repository restarts', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const teamScope = {
      accountId: 'account-a',
      apiBaseUrl: 'https://ola.example.invalid',
      workspaceId: 'team-a'
    }
    const personalScope = { ...teamScope, workspaceId: 'local-personal' }
    const teamKey = {
      scopeHash: workspaceSyncScopeHash(teamScope),
      workspaceId: teamScope.workspaceId,
      providerId: 'webdav'
    }
    const personalKey = {
      scopeHash: workspaceSyncScopeHash(personalScope),
      workspaceId: personalScope.workspaceId,
      providerId: 'webdav'
    }
    const baseline = [
      { domain: 'db:draw_runs', recordId: 'draw-team', contentHash: 'a'.repeat(64) }
    ]
    const tombstones = [
      {
        domain: 'db:draw_runs',
        recordId: 'draw-old',
        deletedAt: 10,
        originDeviceId: 'device-a',
        workspaceId: 'team-a'
      }
    ]
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await repository.saveWorkspaceSyncMetadata({
        ...teamKey,
        syncedAt: 11,
        baseline,
        tombstones
      })
      await expect(repository.workspaceSyncMetadata(personalKey)).resolves.toEqual({
        baseline: [],
        tombstones: []
      })
      await expect(
        repository.workspaceSyncMetadata({ ...teamKey, workspaceId: 'local-personal' })
      ).resolves.toEqual({ baseline: [], tombstones: [] })
      await expect(
        repository.saveWorkspaceSyncMetadata({
          ...teamKey,
          syncedAt: 12,
          baseline: [baseline[0], baseline[0]],
          tombstones: []
        })
      ).rejects.toThrow()
      await expect(repository.workspaceSyncMetadata(teamKey)).resolves.toEqual({
        baseline,
        tombstones
      })
      await expect(
        repository.saveWorkspaceSyncMetadata({
          ...teamKey,
          workspaceId: 'local-personal',
          syncedAt: 12,
          baseline: [],
          tombstones: []
        })
      ).rejects.toThrow('BUSINESS_SYNC_WORKSPACE_MISMATCH')
    } finally {
      await repository.close()
    }
    const reopened = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await expect(reopened.workspaceSyncMetadata(teamKey)).resolves.toEqual({
        baseline,
        tombstones
      })
    } finally {
      await reopened.close()
    }
  })

  it('discovers a stable scoped tombstone for an offline draw deletion', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const scope = {
      accountId: 'account-a',
      apiBaseUrl: 'https://ola.example.invalid',
      workspaceId: 'team-a'
    }
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    const authorize = async () => undefined
    const capture = (owner: BusinessRepository, createdAt: number, providerId = 'webdav') =>
      captureWorkspaceDrawBundle({
        repository: owner,
        scope,
        providerId,
        deviceId: 'device-a',
        appVersion: '1.0.5',
        createdAt,
        authorize
      })
    try {
      const first = await capture(repository, 10)
      await repository.saveWorkspaceSyncMetadata({
        scopeHash: workspaceSyncScopeHash(scope),
        workspaceId: 'team-a',
        providerId: 'webdav',
        syncedAt: 10,
        baseline: first.records.map((record) => ({
          domain: record.domain,
          recordId: record.recordId,
          contentHash: record.hash
        })),
        tombstones: []
      })
      const state = await captureWorkspaceDrawState({
        repository,
        scope,
        providerId: 'webdav',
        deviceId: 'device-a',
        appVersion: '1.0.5',
        createdAt: 11,
        authorize
      })
      expect(state.baseline).toEqual(
        first.records.map((record) => ({
          domain: record.domain,
          recordId: record.recordId,
          contentHash: record.hash
        }))
      )
      expect(state.bundle.records.map((record) => record.recordId)).toEqual(['draw-team'])
      expect(await repository.deleteDrawRun('draw-team', 'team-a')).toBe(true)
      const deleted = await capture(repository, 20)
      expect(deleted.records).toEqual([])
      expect(deleted.tombstones).toEqual([
        {
          domain: 'db:draw_runs',
          recordId: 'draw-team',
          deletedAt: 20,
          originDeviceId: 'device-a',
          workspaceId: 'team-a'
        }
      ])
      expect((await capture(repository, 30)).tombstones).toEqual(deleted.tombstones)
      expect((await capture(repository, 30, 'another-provider')).tombstones).toEqual([])
    } finally {
      await repository.close()
    }
    const reopened = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      expect((await capture(reopened, 40)).tombstones[0].deletedAt).toBe(20)
      await reopened.saveDrawRun({
        id: 'draw-team',
        workspaceId: 'team-a',
        prompt: 'Restored drawing',
        providerName: 'Provider',
        modelName: 'Model',
        createdAt: 41,
        isGenerating: false,
        imagesJson: '[]',
        updatedAt: 41
      })
      const restored = await capture(reopened, 42)
      expect(restored.records.map((record) => record.recordId)).toEqual(['draw-team'])
      expect(restored.tombstones).toEqual([])
      await expect(reopened.drawRuns('local-personal')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-personal' })
      ])
    } finally {
      await reopened.close()
    }
  })

  it('commits a merged draw and baseline atomically only if the captured local state is unchanged', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    const scope = {
      accountId: 'account-a',
      apiBaseUrl: 'https://ola.example.invalid',
      workspaceId: 'team-a'
    }
    const authorize = async () => undefined
    const capture = (createdAt: number) =>
      captureWorkspaceDrawState({
        repository,
        scope,
        providerId: 'webdav',
        deviceId: 'device-a',
        appVersion: '1.0.5',
        createdAt,
        authorize
      })
    const remoteChange = (bundle: Awaited<ReturnType<typeof capture>>, prompt: string) => {
      const remote = structuredClone(bundle.bundle)
      const value = remote.records[0].value as { row: { prompt: string; updated_at: number } }
      value.row.prompt = prompt
      value.row.updated_at += 1
      remote.records[0].hash = hashSyncRecordValue(value)
      remote.records[0].updatedAt = value.row.updated_at
      const { contentHash: _ignored, ...manifest } = remote.manifest
      remote.manifest.contentHash = hashSyncBundleContent(
        manifest,
        remote.records,
        remote.tombstones
      )
      return remote
    }
    try {
      const first = await capture(10)
      await repository.saveWorkspaceSyncMetadata({
        scopeHash: workspaceSyncScopeHash(scope),
        workspaceId: 'team-a',
        providerId: 'webdav',
        syncedAt: 10,
        baseline: first.bundle.records.map((record) => ({
          domain: record.domain,
          recordId: record.recordId,
          contentHash: record.hash
        })),
        tombstones: []
      })
      const captured = await capture(11)
      const remote = remoteChange(captured, 'Remote drawing')
      const merge = mergeWorkspaceDrawBundles({
        scope,
        local: captured.bundle,
        remote,
        baseline: captured.baseline,
        createdAt: 12
      })
      expect(merge.status).toBe('ready')
      await expect(
        commitWorkspaceDrawMerge({
          repository,
          scope,
          providerId: 'webdav',
          captured,
          merge,
          syncedAt: 12,
          authorize
        })
      ).resolves.toMatchObject({ saved: 1, deleted: 0 })
      await expect(repository.drawRuns('team-a')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-team', prompt: 'Remote drawing' })
      ])
      await expect(
        repository.workspaceSyncMetadata({
          scopeHash: workspaceSyncScopeHash(scope),
          workspaceId: 'team-a',
          providerId: 'webdav'
        })
      ).resolves.toMatchObject({
        baseline: [{ recordId: 'draw-team', contentHash: remote.records[0].hash }]
      })
      const stale = await capture(13)
      const laterRemote = remoteChange(stale, 'Another remote drawing')
      const staleMerge = mergeWorkspaceDrawBundles({
        scope,
        local: stale.bundle,
        remote: laterRemote,
        baseline: stale.baseline,
        createdAt: 14
      })
      await repository.saveDrawRun({
        id: 'draw-team',
        workspaceId: 'team-a',
        prompt: 'Offline local edit',
        providerName: 'Provider',
        modelName: 'Model',
        createdAt: 2,
        isGenerating: false,
        imagesJson: '[]',
        updatedAt: 15
      })
      await expect(
        commitWorkspaceDrawMerge({
          repository,
          scope,
          providerId: 'webdav',
          captured: stale,
          merge: staleMerge,
          syncedAt: 14,
          authorize
        })
      ).rejects.toThrow('BUSINESS_DRAW_SYNC_LOCAL_CHANGED')
      expect((await repository.drawRuns<{ prompt: string }>('team-a'))[0].prompt).toBe(
        'Offline local edit'
      )
      expect(
        (
          await repository.workspaceSyncMetadata({
            scopeHash: workspaceSyncScopeHash(scope),
            workspaceId: 'team-a',
            providerId: 'webdav'
          })
        ).baseline[0].contentHash
      ).toBe(remote.records[0].hash)
      const deletedLocal = await capture(16)
      const remoteDeletion = structuredClone(deletedLocal.bundle)
      remoteDeletion.records = []
      remoteDeletion.tombstones = [
        {
          domain: 'db:draw_runs',
          recordId: 'draw-team',
          deletedAt: 16,
          originDeviceId: 'device-b',
          workspaceId: 'team-a'
        }
      ]
      remoteDeletion.manifest.domains = {}
      remoteDeletion.manifest.tombstones = 1
      const { contentHash: _deletionHash, ...deletionManifest } = remoteDeletion.manifest
      remoteDeletion.manifest.contentHash = hashSyncBundleContent(
        deletionManifest,
        remoteDeletion.records,
        remoteDeletion.tombstones
      )
      const pending = mergeWorkspaceDrawBundles({
        scope,
        local: deletedLocal.bundle,
        remote: remoteDeletion,
        baseline: deletedLocal.baseline,
        createdAt: 17
      })
      expect(pending).toMatchObject({ status: 'conflict', conflicts: [{ kind: 'delete-modify' }] })
      if (pending.status !== 'conflict') throw new Error('Expected deletion conflict')
      const resolved = mergeWorkspaceDrawBundles({
        scope,
        local: deletedLocal.bundle,
        remote: remoteDeletion,
        baseline: deletedLocal.baseline,
        resolutions: [{ conflictId: pending.conflicts[0].id, choice: 'remote' }],
        createdAt: 17
      })
      await expect(
        commitWorkspaceDrawMerge({
          repository,
          scope,
          providerId: 'webdav',
          captured: deletedLocal,
          merge: resolved,
          syncedAt: 17,
          authorize
        })
      ).resolves.toMatchObject({ saved: 0, deleted: 1 })
      await expect(repository.drawRuns('team-a')).resolves.toEqual([])
      await expect(repository.drawRuns('local-personal')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-personal' })
      ])
      await expect(
        repository.workspaceSyncMetadata({
          scopeHash: workspaceSyncScopeHash(scope),
          workspaceId: 'team-a',
          providerId: 'webdav'
        })
      ).resolves.toMatchObject({ baseline: [], tombstones: remoteDeletion.tombstones })
    } finally {
      await repository.close()
    }
  })

  it('runs the staged draw round trip without uploading conflicts or committing failed uploads', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    const scope = {
      accountId: 'account-a',
      apiBaseUrl: 'https://ola.example.invalid',
      workspaceId: 'team-a'
    }
    const server: { bundle: WorkspaceSyncBundle | null } = { bundle: null }
    let etag = 0
    let uploads = 0
    let rejectUpload = false
    const transport: Parameters<typeof runWorkspaceDrawSync>[0]['transport'] = {
      async downloadWorkspace() {
        return {
          bundle: server.bundle,
          etag: server.bundle ? `etag-${etag}` : null,
          lastModified: null,
          updatedAt: null
        }
      },
      async uploadWorkspace(_config, _scope, bundle, options) {
        if (rejectUpload) throw new Error('REMOTE_CHANGED')
        if (options.previousExists !== (server.bundle !== null)) throw new Error('REMOTE_CHANGED')
        if (server.bundle && options.previousEtag !== `etag-${etag}`)
          throw new Error('REMOTE_CHANGED')
        server.bundle = bundle
        etag += 1
        uploads += 1
        return { bundle: server.bundle, etag: `etag-${etag}`, lastModified: null, updatedAt: null }
      }
    }
    const config = {
      displayName: 'Test',
      serverUrl: 'https://dav.example.invalid',
      username: '',
      password: '',
      remoteDir: 'ola-sync',
      autoSyncEnabled: false,
      syncIntervalMinutes: 30,
      backupRetention: 0
    }
    const authorize = async () => undefined
    const run = (
      createdAt: number,
      resolutions?: Parameters<typeof runWorkspaceDrawSync>[0]['resolutions']
    ) =>
      runWorkspaceDrawSync({
        repository,
        transport,
        config,
        scope,
        providerId: 'webdav',
        deviceId: 'device-a',
        appVersion: '1.0.5',
        createdAt,
        resolutions,
        authorize
      })
    try {
      await expect(run(10)).resolves.toMatchObject({ status: 'success', uploadedRecords: 1 })
      expect(uploads).toBe(1)
      expect(server.bundle?.records.map((row) => row.recordId)).toEqual(['draw-team'])
      const uploadedBundle = server.bundle
      if (!uploadedBundle) throw new Error('Expected uploaded bundle')
      const initialHash = uploadedBundle.records[0].hash
      await repository.saveDrawRun({
        id: 'draw-team',
        workspaceId: 'team-a',
        prompt: 'Local change',
        providerName: 'Provider',
        modelName: 'Model',
        createdAt: 2,
        isGenerating: false,
        imagesJson: '[]',
        updatedAt: 11
      })
      const changedRemote = structuredClone(uploadedBundle)
      const value = changedRemote.records[0].value as {
        row: { prompt: string; updated_at: number }
      }
      value.row.prompt = 'Remote change'
      value.row.updated_at = 12
      changedRemote.records[0].hash = hashSyncRecordValue(value)
      changedRemote.records[0].updatedAt = 12
      const { contentHash: _ignored, ...manifest } = changedRemote.manifest
      changedRemote.manifest.contentHash = hashSyncBundleContent(
        manifest,
        changedRemote.records,
        changedRemote.tombstones
      )
      server.bundle = changedRemote
      etag += 1
      const conflict = await run(13)
      expect(conflict).toMatchObject({
        status: 'conflict',
        conflicts: [{ kind: 'modify-modify', recordId: 'draw-team' }]
      })
      if (conflict.status !== 'conflict') throw new Error('Expected concurrent edit conflict')
      expect(uploads).toBe(1)
      expect((await repository.drawRuns<{ prompt: string }>('team-a'))[0].prompt).toBe(
        'Local change'
      )
      expect(
        (
          await repository.workspaceSyncMetadata({
            scopeHash: workspaceSyncScopeHash(scope),
            workspaceId: 'team-a',
            providerId: 'webdav'
          })
        ).baseline[0].contentHash
      ).toBe(initialHash)
      rejectUpload = true
      await expect(
        run(14, [{ conflictId: conflict.conflicts[0].id, choice: 'local' }])
      ).rejects.toThrow('REMOTE_CHANGED')
      expect(uploads).toBe(1)
      expect((await repository.drawRuns<{ prompt: string }>('team-a'))[0].prompt).toBe(
        'Local change'
      )
      rejectUpload = false
      const malformed = structuredClone(changedRemote)
      const malformedValue = malformed.records[0].value as { row: { images_json: string } }
      malformedValue.row.images_json = '{broken'
      malformed.records[0].hash = hashSyncRecordValue(malformedValue)
      const { contentHash: _malformedHash, ...malformedManifest } = malformed.manifest
      malformed.manifest.contentHash = hashSyncBundleContent(
        malformedManifest,
        malformed.records,
        malformed.tombstones
      )
      server.bundle = malformed
      etag += 1
      await expect(run(15)).rejects.toThrow('SYNC_DRAW_ROW_INVALID')
      expect(uploads).toBe(1)
      const forged = structuredClone(uploadedBundle)
      const forgedRecord = structuredClone(forged.records[0])
      forgedRecord.recordId = 'draw-personal'
      const forgedValue = forgedRecord.value as { row: { id: string } }
      forgedValue.row.id = 'draw-personal'
      forgedRecord.hash = hashSyncRecordValue(forgedValue)
      forged.records.push(forgedRecord)
      forged.manifest.domains['db:draw_runs'] = 2
      const { contentHash: _forgedHash, ...forgedManifest } = forged.manifest
      forged.manifest.contentHash = hashSyncBundleContent(
        forgedManifest,
        forged.records,
        forged.tombstones
      )
      server.bundle = forged
      etag += 1
      await expect(run(16)).rejects.toThrow('BUSINESS_DRAW_WORKSPACE_MISMATCH')
      expect(uploads).toBe(1)
      await expect(repository.drawRuns('local-personal')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-personal' })
      ])
    } finally {
      await repository.close()
    }
  })

  it('round-trips a team drawing through WebDAV transport and the TS handover repository', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    const scope = {
      accountId: 'account-a',
      apiBaseUrl: 'https://ola.example.invalid',
      workspaceId: 'team-a'
    }
    const statePath = `/workspaces-v2/${workspaceSyncScopeHash(scope)}/state.json.gz`
    let remoteBody: Buffer | null = null
    let etag = 0
    let uploads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        if (options.method === 'MKCOL') return new Response(null, { status: 201 })
        if (options.method === 'PROPFIND') {
          if (!url.endsWith('state.json.gz'))
            return new Response('<d:multistatus/>', { status: 207 })
          expect(url).toContain(statePath)
          return remoteBody
            ? new Response(`<d:getetag>"etag-${etag}"</d:getetag>`, { status: 207 })
            : new Response(null, { status: 404 })
        }
        if (options.method === 'PUT') {
          expect(url).toContain(statePath)
          const headers = options.headers as Record<string, string>
          if (remoteBody) expect(headers['If-Match']).toBe(`"etag-${etag}"`)
          else expect(headers['If-None-Match']).toBe('*')
          const creating = remoteBody === null
          remoteBody = Buffer.from(options.body as ArrayBuffer)
          etag += 1
          uploads += 1
          return new Response(null, { status: creating ? 201 : 204 })
        }
        if (options.method === 'GET') {
          expect(url).toContain(statePath)
          if (!remoteBody) return new Response(null, { status: 404 })
          return new Response(new Uint8Array(remoteBody), {
            status: 200,
            headers: { etag: `"etag-${etag}"` }
          })
        }
        throw new Error(`Unexpected WebDAV request: ${options.method}`)
      })
    )
    const config = {
      displayName: 'Test',
      serverUrl: 'https://dav.example.invalid',
      username: '',
      password: '',
      remoteDir: 'ola-sync',
      autoSyncEnabled: false,
      syncIntervalMinutes: 30,
      backupRetention: 0
    }
    const run = (createdAt: number) =>
      runWorkspaceDrawSync({
        repository,
        transport: new WebDavProvider(),
        config,
        scope,
        providerId: 'webdav',
        deviceId: 'device-a',
        appVersion: '1.0.5',
        createdAt,
        authorize: async () => undefined
      })
    try {
      await expect(run(10)).resolves.toMatchObject({ status: 'success', uploadedRecords: 1 })
      expect(uploads).toBe(1)
      if (!remoteBody) throw new Error('Expected uploaded state')
      const changed = JSON.parse(gunzipSync(remoteBody).toString('utf8')) as WorkspaceSyncBundle
      const value = changed.records[0].value as { row: { prompt: string; updated_at: number } }
      value.row.prompt = 'Changed on another device'
      value.row.updated_at = 11
      changed.records[0].hash = hashSyncRecordValue(value)
      changed.records[0].updatedAt = 11
      const { contentHash: _ignored, ...manifest } = changed.manifest
      changed.manifest.contentHash = hashSyncBundleContent(
        manifest,
        changed.records,
        changed.tombstones
      )
      remoteBody = gzipSync(JSON.stringify(changed))
      etag += 1
      await expect(run(12)).resolves.toMatchObject({ status: 'success', downloadedRecords: 1 })
      expect(uploads).toBe(2)
      await expect(repository.drawRuns('team-a')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-team', prompt: 'Changed on another device' })
      ])
      await expect(repository.drawRuns('local-personal')).resolves.toEqual([
        expect.objectContaining({ id: 'draw-personal' })
      ])
    } finally {
      await repository.close()
    }
  })

  it('reports scoped raw usage with Native-compatible grouping and filters', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await expect(
        repository.queryRawUsage('overview', {
          workspaceId: 'team-a',
          from: 0,
          to: 1000
        })
      ).resolves.toMatchObject({
        row: { request_count: 1, input_tokens: 20, total_input_tokens: 20, output_tokens: 3 }
      })
      await expect(
        repository.queryRawUsage('overview', {
          workspaceId: 'team-a',
          from: 0,
          to: 1000,
          providerId: 'different'
        })
      ).resolves.toMatchObject({ row: { request_count: 0 } })
      for (const operation of ['daily', 'timeline', 'by-model', 'by-provider'] as const) {
        const result = await repository.queryRawUsage<Record<string, unknown>>(operation, {
          workspaceId: 'team-a',
          from: 0,
          to: 1000
        })
        expect(result.rows).toEqual([
          expect.objectContaining({ request_count: 1, input_tokens: 20 })
        ])
      }
      await expect(
        repository.queryRawUsage('by-model', {
          workspaceId: 'local-personal',
          from: 0,
          to: 1000,
          modelId: 'model-a'
        })
      ).resolves.toMatchObject({ rows: [expect.objectContaining({ input_tokens: 10 })] })
      await expect(
        repository.usageEvents({
          workspaceId: 'team-a',
          from: 1000,
          to: 1000,
          providerId: 'provider-a'
        })
      ).resolves.toEqual([expect.objectContaining({ id: 'usage-team' })])
      await expect(
        repository.deleteUsageEvents({
          workspaceId: 'team-a',
          from: 1000,
          to: 1000,
          sourceKind: 'agent'
        })
      ).resolves.toBe(0)
      await expect(
        repository.queryActivityUsage('activity-overview', {
          workspaceId: 'team-a',
          from: 0,
          to: 1000
        })
      ).resolves.toMatchObject({ row: { request_count: 1, input_tokens: 20 } })
      for (const operation of [
        'activity-daily',
        'activity-by-model',
        'activity-by-provider'
      ] as const) {
        await expect(
          repository.queryActivityUsage(operation, {
            workspaceId: 'team-a',
            from: 0,
            to: 1000
          })
        ).resolves.toMatchObject({
          rows: [expect.objectContaining({ request_count: 1, input_tokens: 20 })]
        })
      }
    } finally {
      await repository.close()
    }
  })

  it('keeps activity after scoped raw deletion and repairs missing activity before maintenance', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const backup = new DatabaseSync(snapshot.backupPath)
    try {
      backup.exec(`
        DELETE FROM usage_activity_daily_v2 WHERE workspace_id='local-personal';
        DELETE FROM usage_activity_daily_models_v2 WHERE workspace_id='local-personal';
        DELETE FROM usage_activity_daily_providers_v2 WHERE workspace_id='local-personal';
      `)
    } finally {
      backup.close()
    }
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await expect(
        repository.deleteUsageEvents({ workspaceId: 'team-a', from: 1000, to: 1000 })
      ).resolves.toBe(1)
      await expect(repository.maintainUsage(2000)).resolves.toEqual({ cutoff: 2000, deleted: 1 })
      for (const [workspaceId, expectedTokens] of [
        ['local-personal', 10],
        ['team-a', 20]
      ] as const) {
        await expect(repository.usageEvents({ workspaceId, from: 0, to: 2000 })).resolves.toEqual(
          []
        )
        for (const dimension of ['daily', 'models', 'providers'] as const) {
          await expect(
            repository.usageActivity({
              workspaceId,
              fromDay: '1970-01-01',
              toDay: '1970-01-01',
              dimension
            })
          ).resolves.toEqual([
            expect.objectContaining({ request_count: 1, input_tokens: expectedTokens })
          ])
        }
      }
    } finally {
      await repository.close()
    }
  })

  it('writes scoped usage and all aggregates atomically after ownership handover', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      const event = {
        id: 'usage-ts-team',
        workspace_id: 'team-a',
        created_at: 2_000,
        source_kind: 'chat',
        provider_id: 'provider-a',
        model_id: 'model-a',
        input_tokens: 50,
        cache_read_tokens: 10,
        cache_creation_tokens: 5,
        output_tokens: 4,
        total_cost_usd: 0.2,
        request_debug_json: '{"secret":"private"}'
      }
      await expect(
        repository.addUsageEvent({ ...event, workspace_id: 'team-a', session_id: 'session-1' })
      ).rejects.toThrow('BUSINESS_USAGE_SOURCE_WORKSPACE_MISMATCH')
      await expect(repository.addUsageEvent(event)).resolves.toMatchObject({
        id: 'usage-ts-team',
        workspace_id: 'team-a'
      })
      await expect(repository.addUsageEvent(event)).rejects.toThrow()
      await expect(
        repository.usageEvents({ workspaceId: 'team-a', from: 0, to: 3000 })
      ).resolves.toEqual([
        expect.objectContaining({
          id: event.id,
          input_tokens: 50,
          request_debug_chars: event.request_debug_json.length
        }),
        expect.objectContaining({ id: 'usage-team' })
      ])
      const [visible] = await repository.usageEvents<Record<string, unknown>>({
        workspaceId: 'team-a',
        from: 0,
        to: 3000
      })
      expect(visible).not.toHaveProperty('request_debug_json')
      for (const dimension of ['daily', 'models', 'providers'] as const) {
        await expect(
          repository.usageActivity({
            workspaceId: 'team-a',
            fromDay: '1970-01-01',
            toDay: '1970-01-01',
            dimension
          })
        ).resolves.toEqual([
          expect.objectContaining({
            request_count: 2,
            input_tokens: 55,
            output_tokens: 7,
            cache_read_tokens: 10,
            cache_creation_tokens: 5,
            total_cost_usd: 0.2
          })
        ])
      }
      await expect(
        repository.usageActivity({
          workspaceId: 'local-personal',
          fromDay: '1970-01-01',
          toDay: '1970-01-01',
          dimension: 'daily'
        })
      ).resolves.toEqual([expect.objectContaining({ request_count: 1, input_tokens: 10 })])
    } finally {
      await repository.close()
    }
  })

  it('reads usage events and activity only from the requested workspace on the TS copy', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      for (const [workspaceId, expectedId, expectedTokens] of [
        ['local-personal', 'usage-personal', 10],
        ['team-a', 'usage-team', 20]
      ] as const) {
        await expect(repository.usageEvents({ workspaceId, from: 0, to: 2000 })).resolves.toEqual([
          expect.objectContaining({
            id: expectedId,
            input_tokens: expectedTokens,
            workspace_id: workspaceId
          })
        ])
        for (const dimension of ['daily', 'models', 'providers'] as const) {
          await expect(
            repository.usageActivity({
              workspaceId,
              fromDay: '1970-01-01',
              toDay: '1970-01-01',
              dimension
            })
          ).resolves.toEqual([
            expect.objectContaining({ workspace_id: workspaceId, input_tokens: expectedTokens })
          ])
        }
      }
      await expect(
        repository.usageEvents({ workspaceId: 'team-b', from: 0, to: 2000 })
      ).resolves.toEqual([])
      await expect(
        repository.usageActivity({
          workspaceId: 'team-b',
          fromDay: '1970-01-01',
          toDay: '1970-01-01',
          dimension: 'daily'
        })
      ).resolves.toEqual([])
      await expect(
        repository.usageActivity({
          workspaceId: 'team-a',
          fromDay: '1970-01-01',
          toDay: '1970-01-01',
          dimension: 'usage_events' as 'daily'
        })
      ).rejects.toThrow('INVALID_BUSINESS_USAGE_DIMENSION')
    } finally {
      await repository.close()
    }
  })

  it('clears only the requested workspace memory root and optionally its jobs', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await expect(
        repository.clearMemoryRoot({
          workspaceId: 'local-personal',
          memoryRootId: 'memory-team',
          includeJobs: true
        })
      ).rejects.toThrow('BUSINESS_MEMORY_ROOT_NOT_FOUND')
      await expect(
        repository.clearMemoryRoot({
          workspaceId: 'team-a',
          memoryRootId: 'memory-team'
        })
      ).resolves.toEqual({ deletedStage1Outputs: 1, deletedJobs: 0 })
      await expect(repository.memoryStage1Outputs('memory-team', 'team-a')).resolves.toEqual([])
      await expect(repository.memoryJobs<{ id: string }>('team-a')).resolves.toEqual([
        expect.objectContaining({ id: 'job-team' })
      ])
      await expect(
        repository.memoryStage1Outputs<{ id: string }>('memory-personal', 'local-personal')
      ).resolves.toEqual([expect.objectContaining({ id: 'output-personal' })])
      await expect(
        repository.clearMemoryRoot({
          workspaceId: 'team-a',
          memoryRootId: 'memory-team',
          includeJobs: true
        })
      ).resolves.toEqual({ deletedStage1Outputs: 0, deletedJobs: 1 })
      await expect(repository.memoryJob('job-team', 'team-a')).resolves.toBeNull()
    } finally {
      await repository.close()
    }
  })

  it('records memory automation, citations and rollups on the TS copy without crossing spaces', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      const entryInput = {
        workspaceId: 'team-a',
        scope: 'main',
        rootScope: 'global',
        memoryRootId: 'memory-team',
        jobId: 'job-team',
        target: 'global_memory',
        kind: 'daily_context',
        content: 'New team memory',
        status: 'written',
        fingerprint: 'new-team-memory',
        sourceSessionId: 'rollup:2026-09-17',
        beforeContent: 'Before',
        afterContent: 'After'
      }
      await expect(
        repository.recordMemoryAutomationEntry({
          ...entryInput,
          workspaceId: 'local-personal'
        })
      ).rejects.toThrow('BUSINESS_MEMORY_ROOT_NOT_FOUND')
      const otherRoot = await repository.ensureMemoryRoot<{ id: string }>({
        workspaceId: 'team-a',
        scope: 'global',
        transport: 'local',
        rootPath: '/team/other-memory'
      })
      const otherJob = await repository.createMemoryJob<{ id: string }>({
        workspaceId: 'team-a',
        kind: 'phase2',
        status: 'running',
        memoryRootId: otherRoot.id,
        sourceSessionId: 'rollup:2026-09-17'
      })
      await expect(
        repository.recordMemoryAutomationEntry({
          ...entryInput,
          jobId: otherJob.id
        })
      ).rejects.toThrow('BUSINESS_MEMORY_JOB_ROOT_MISMATCH')
      const entry = await repository.recordMemoryAutomationEntry<{ id: string }>(entryInput)
      await expect(repository.memoryAutomationEntry(entry.id, 'team-a')).resolves.toMatchObject({
        content: 'New team memory',
        after_content: 'After'
      })
      await expect(repository.memoryAutomationEntries<{ id: string }>('team-a')).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: entry.id,
            before_content: null,
            after_content: null,
            appended_text: null
          })
        ])
      )
      await expect(repository.memoryAutomationEntries('team-a', 200, 0, true)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: entry.id, after_content: 'After' })])
      )
      await expect(
        repository.markMemoryAutomationUndo({
          id: entry.id,
          workspaceId: 'local-personal',
          status: 'undone'
        })
      ).resolves.toBeNull()
      await expect(
        repository.markMemoryAutomationUndo({
          id: entry.id,
          workspaceId: 'team-a',
          status: 'undone'
        })
      ).resolves.toMatchObject({ status: 'undone' })
      await expect(
        repository.markMemoryAutomationUndo({
          id: entry.id,
          workspaceId: 'team-a',
          status: 'error'
        })
      ).resolves.toBeNull()
      await expect(
        repository.recordMemoryCitationUsage({
          workspaceId: 'local-personal',
          memoryRootId: 'memory-team',
          scope: 'global',
          path: '/team/MEMORY.md'
        })
      ).rejects.toThrow('BUSINESS_MEMORY_ROOT_NOT_FOUND')
      await expect(
        repository.recordMemoryCitationUsage({
          workspaceId: 'team-a',
          memoryRootId: 'memory-team',
          scope: 'global',
          path: '/team/MEMORY.md',
          sourceSessionId: 'rollup:2026-09-17'
        })
      ).resolves.toBe(1)
      await expect(
        repository.memoryStage1Outputs<{ usage_count: number }>('memory-team', 'team-a')
      ).resolves.toEqual([expect.objectContaining({ usage_count: 1 })])
      await expect(
        repository.markMemoryRollup({
          workspaceId: 'team-a',
          scope: 'main',
          target: 'global_memory',
          targetPath: '/team/new-memory',
          sourceDate: '2026-09-17',
          contentHash: 'new-hash'
        })
      ).resolves.toBe(true)
      await expect(repository.memoryRollups<{ target_path: string }>('team-a')).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ target_path: '/team/new-memory' })])
      )
      await expect(repository.memoryRollups('local-personal')).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ target_path: '/team/new-memory' })])
      )
    } finally {
      await repository.close()
    }
  })

  it('writes team memory roots, Stage1 output and jobs only in their owner workspace', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await repository.createProject({
        id: 'personal-memory-project',
        name: 'Personal memory project',
        workspaceId: 'local-personal',
        createdAt: 1,
        updatedAt: 1
      })
      await expect(
        repository.ensureMemoryRoot({
          workspaceId: 'team-a',
          scope: 'project',
          transport: 'local',
          projectId: 'personal-memory-project',
          rootPath: '/team/project-memory'
        })
      ).rejects.toThrow('BUSINESS_MEMORY_PROJECT_NOT_FOUND')
      const rootInput = {
        workspaceId: 'team-a',
        scope: 'global' as const,
        rootPath: '/team/new-memory',
        transport: 'local' as const
      }
      const root = await repository.ensureMemoryRoot<{ id: string; owner_key: string }>(rootInput)
      expect(root.owner_key).toContain('6:team-a::global::local::')
      await expect(repository.ensureMemoryRoot(rootInput)).resolves.toMatchObject({ id: root.id })
      await expect(repository.memoryRoot(root.id, 'local-personal')).resolves.toBeNull()
      await expect(
        repository.addMemoryStage1Output({
          workspaceId: 'local-personal',
          memoryRootId: root.id,
          scope: 'global',
          sourceSessionId: 'session-1',
          rawMemory: 'Wrong workspace',
          rolloutSummary: 'Wrong workspace',
          rolloutSlug: 'wrong',
          fingerprint: 'wrong'
        })
      ).rejects.toThrow('BUSINESS_MEMORY_ROOT_NOT_FOUND')
      await expect(
        repository.addMemoryStage1Output({
          workspaceId: 'team-a',
          memoryRootId: root.id,
          scope: 'global',
          sourceSessionId: 'session-1',
          rawMemory: 'Wrong source',
          rolloutSummary: 'Wrong source',
          rolloutSlug: 'wrong-source',
          fingerprint: 'wrong-source'
        })
      ).rejects.toThrow('BUSINESS_MEMORY_SESSION_NOT_FOUND')
      const stage1Input = {
        workspaceId: 'team-a',
        memoryRootId: root.id,
        scope: 'global' as const,
        sourceSessionId: 'rollup:2026-09-17',
        rawMemory: 'Team-only memory',
        rolloutSummary: 'Team summary',
        rolloutSlug: 'team-rollup',
        fingerprint: 'team-rollup-v1'
      }
      const first = await repository.addMemoryStage1Output<{ id: string; raw_memory: string }>(
        stage1Input
      )
      await expect(
        repository.addMemoryStage1Output({ ...stage1Input, rawMemory: 'Updated team memory' })
      ).resolves.toMatchObject({ id: first.id, raw_memory: 'Updated team memory' })
      await repository.addMemoryStage1Output({
        ...stage1Input,
        fingerprint: 'team-rollup-superseded',
        status: 'superseded'
      })
      await expect(
        repository.memoryStage1Outputs<{ id: string }>(root.id, 'team-a')
      ).resolves.toEqual([expect.objectContaining({ id: first.id })])
      await expect(repository.memoryStage1Output(first.id, 'local-personal')).resolves.toBeNull()
      await expect(
        repository.createMemoryJob({
          workspaceId: 'local-personal',
          kind: 'phase2',
          status: 'running',
          memoryRootId: root.id
        })
      ).rejects.toThrow('BUSINESS_MEMORY_ROOT_NOT_FOUND')
      const job = await repository.createMemoryJob<{ id: string }>({
        workspaceId: 'team-a',
        kind: 'phase2',
        status: 'running',
        memoryRootId: root.id,
        sourceSessionId: 'rollup:2026-09-17',
        leaseOwner: 'test'
      })
      await expect(
        repository.finishMemoryJob({
          id: job.id,
          workspaceId: 'local-personal',
          status: 'succeeded'
        })
      ).resolves.toBeNull()
      await expect(
        repository.finishMemoryJob({
          id: job.id,
          workspaceId: 'team-a',
          status: 'succeeded'
        })
      ).resolves.toMatchObject({ id: job.id, status: 'succeeded', lease_owner: null })
      await expect(
        repository.finishMemoryJob({
          id: job.id,
          workspaceId: 'team-a',
          status: 'failed'
        })
      ).resolves.toBeNull()
    } finally {
      await repository.close()
    }
  })

  it('reads memory roots and Stage1 output only through their workspace ownership', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await expect(repository.memoryRoots<{ id: string }>('team-a')).resolves.toEqual([
        expect.objectContaining({ id: 'memory-team', workspace_id: 'team-a' })
      ])
      await expect(repository.memoryRoot('memory-team', 'local-personal')).resolves.toBeNull()
      await expect(
        repository.memoryStage1Outputs('memory-team', 'local-personal')
      ).resolves.toEqual([])
      await expect(
        repository.memoryStage1Output('output-team', 'local-personal')
      ).resolves.toBeNull()
      await expect(
        repository.memoryStage1Outputs<{ raw_memory: string }>('memory-team', 'team-a')
      ).resolves.toEqual([expect.objectContaining({ raw_memory: 'Team detail' })])
      await expect(repository.memoryStage1Outputs('memory-personal', 'team-a')).resolves.toEqual([])
      await expect(
        repository.memoryStage1Output<{ id: string }>('output-personal', 'team-a')
      ).resolves.toBeNull()
      await expect(repository.memoryJobs<{ id: string }>('team-a')).resolves.toEqual([
        expect.objectContaining({ id: 'job-team' })
      ])
      await expect(repository.memoryJob('job-team', 'local-personal')).resolves.toBeNull()
      await expect(repository.memoryJob('job-inconsistent', 'team-a')).resolves.toBeNull()
      await expect(
        repository.memoryAutomationEntries<{ content: string }>('team-a')
      ).resolves.toEqual([expect.objectContaining({ content: 'Team note' })])
      await expect(
        repository.memoryAutomationEntry('entry-team', 'local-personal')
      ).resolves.toBeNull()
      await expect(
        repository.memoryAutomationEntry('entry-inconsistent', 'team-a')
      ).resolves.toBeNull()
      await expect(repository.memoryRollups<{ target_path: string }>('team-a')).resolves.toEqual([
        expect.objectContaining({ target_path: '/team' })
      ])
      await expect(repository.memoryRollups('local-personal')).resolves.toEqual([
        expect.objectContaining({ target_path: '/personal' })
      ])
      await expect(
        repository.memoryCitationUsage<{ path: string }>('memory-team', 'team-a')
      ).resolves.toEqual([expect.objectContaining({ path: '/team/MEMORY.md' })])
      await expect(
        repository.memoryCitationUsage('memory-team', 'local-personal')
      ).resolves.toEqual([])
    } finally {
      await repository.close()
    }
  })

  it('keeps the full Cron job list and original job in run detail after TS handover', async () => {
    const fixture = await createFixture()
    const database = new DatabaseSync(fixture.sourcePath)
    try {
      const insert = database.prepare(`
        INSERT INTO cron_jobs (
          id,name,schedule_kind,schedule_every,schedule_tz,prompt,delivery_mode,
          enabled,delete_after_run,max_iterations,fire_count,created_at,updated_at,workspace_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      database.exec('BEGIN')
      for (let index = 0; index < 205; index++) {
        insert.run(
          `cron-extra-${index}`,
          `Extra ${index}`,
          'every',
          60_000,
          'UTC',
          'Test',
          'none',
          1,
          0,
          5,
          0,
          index + 2,
          index + 2,
          'local-personal'
        )
      }
      database.exec('COMMIT')
    } finally {
      database.close()
    }
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      const jobs = await repository.cronJobs<{ id: string }>('local-personal')
      expect(jobs).toHaveLength(206)
      expect(jobs.some((job) => job.id === 'cron-1')).toBe(true)
      await expect(repository.cronJobs('local-personal', { limit: 10 })).resolves.toHaveLength(10)
      await expect(repository.cronJobs('local-personal', { offset: 200 })).resolves.toHaveLength(6)
      await expect(
        repository.cronRunDetail<{ job: { id: string; name: string } }>(
          'cron-run-1',
          'local-personal'
        )
      ).resolves.toMatchObject({ job: { id: 'cron-1', name: 'Legacy cron' } })
      await expect(repository.cronRunDetail('cron-run-1', 'team-a')).resolves.toBeNull()
    } finally {
      await repository.close()
    }
  })

  it('starts Cron runs and records firing atomically without duplicate schedules', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      const first = {
        id: 'run-atomic-1',
        jobId: 'cron-1',
        workspaceId: 'local-personal',
        startedAt: 100,
        firedAt: 100,
        scheduledFor: 100
      }
      await expect(repository.startCronRun({ ...first, workspaceId: 'team-a' })).rejects.toThrow(
        'BUSINESS_CRON_JOB_NOT_FOUND'
      )
      await expect(
        repository.startCronRun({
          ...first,
          modelSourceSnapshot: JSON.stringify({
            kind: 'ola-team',
            workspaceId: 'team-a',
            resourceId: 'foreign-model'
          })
        })
      ).rejects.toThrow('INVALID_BUSINESS_CRON_MODEL_SOURCE')
      await expect(
        repository.startCronRun({
          ...first,
          sourceProviderIdSnapshot: 'ola-managed:team-a'
        })
      ).rejects.toThrow('INVALID_BUSINESS_CRON_SOURCE_PROVIDER')
      await repository.createSession({
        id: 'foreign-cron-session',
        title: 'Foreign cron source',
        mode: 'chat',
        createdAt: 2,
        updatedAt: 2,
        workspaceId: 'team-a'
      })
      await repository.createProject({
        id: 'foreign-cron-project',
        name: 'Foreign cron project',
        createdAt: 2,
        updatedAt: 2,
        workspaceId: 'team-a'
      })
      await expect(
        repository.startCronRun({ ...first, sourceSessionIdSnapshot: 'foreign-cron-session' })
      ).rejects.toThrow('BUSINESS_CRON_SESSION_WORKSPACE_MISMATCH')
      await expect(
        repository.startCronRun({ ...first, sourceProjectIdSnapshot: 'foreign-cron-project' })
      ).rejects.toThrow('BUSINESS_CRON_PROJECT_WORKSPACE_MISMATCH')
      await expect(
        repository.cronJob<{ fire_count: number }>('cron-1', 'local-personal')
      ).resolves.toMatchObject({ fire_count: 0 })
      await expect(repository.startCronRun(first)).resolves.toEqual({
        started: true,
        runId: first.id
      })
      await expect(
        repository.startCronRun({ ...first, id: 'run-atomic-overlap', scheduledFor: 101 })
      ).resolves.toEqual({ started: false, reason: 'already-running' })
      await repository.finishCronRun({
        id: first.id,
        workspaceId: 'local-personal',
        finishedAt: 102,
        status: 'success',
        toolCallCount: 0
      })
      await expect(
        repository.startCronRun({ ...first, id: 'run-atomic-duplicate' })
      ).resolves.toEqual({
        started: false,
        reason: 'duplicate-schedule'
      })
      await expect(
        repository.startCronRun({ ...first, id: 'run-atomic-2', firedAt: 200, scheduledFor: 200 })
      ).resolves.toEqual({ started: true, runId: 'run-atomic-2' })
      await expect(
        repository.cronJob<{ fire_count: number; last_fired_at: number }>(
          'cron-1',
          'local-personal'
        )
      ).resolves.toMatchObject({ fire_count: 2, last_fired_at: 200 })
      await expect(repository.cronRuns<{ id: string }>('local-personal')).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'run-atomic-1' }),
          expect.objectContaining({ id: 'run-atomic-2' })
        ])
      )
      await repository.createCronJob({
        id: 'cron-once',
        workspaceId: 'local-personal',
        name: 'Once',
        scheduleKind: 'at',
        scheduleAt: 500,
        prompt: 'Run once',
        createdAt: 1
      })
      await expect(
        repository.startCronRun({
          id: 'once-1',
          jobId: 'cron-once',
          workspaceId: 'local-personal',
          startedAt: 500,
          firedAt: 500,
          scheduledFor: 500
        })
      ).resolves.toMatchObject({ started: true })
      await repository.finishCronRun({
        id: 'once-1',
        workspaceId: 'local-personal',
        finishedAt: 501,
        status: 'success',
        toolCallCount: 0
      })
      await expect(
        repository.startCronRun({
          id: 'once-2',
          jobId: 'cron-once',
          workspaceId: 'local-personal',
          startedAt: 502,
          firedAt: 502,
          scheduledFor: 502
        })
      ).resolves.toEqual({ started: false, reason: 'already-fired' })
    } finally {
      await repository.close()
    }
  })

  it('recovers interrupted Cron runs and expired one-shot jobs only in the requested workspace', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await repository.createCronJob({
        id: 'cron-expired',
        workspaceId: 'local-personal',
        name: 'Expired once',
        scheduleKind: 'at',
        scheduleAt: 5,
        prompt: 'Past run',
        deleteAfterRun: true,
        createdAt: 2
      })
      await repository.createCronJob({
        id: 'cron-team',
        workspaceId: 'team-a',
        name: 'Team job',
        scheduleKind: 'every',
        scheduleEvery: 60_000,
        prompt: 'Team run',
        createdAt: 2
      })
      await repository.createCronRun({
        id: 'run-local',
        jobId: 'cron-1',
        workspaceId: 'local-personal',
        startedAt: 3
      })
      await repository.createCronRun({
        id: 'run-team',
        jobId: 'cron-team',
        workspaceId: 'team-a',
        startedAt: 3
      })
      await expect(
        repository.recoverCronJobs<{ id: string }>('local-personal', 10)
      ).resolves.toMatchObject({
        jobs: [expect.objectContaining({ id: 'cron-1' })],
        abortedRuns: 1,
        expiredJobs: 1
      })
      await expect(
        repository.cronRunDetail<{ run: { status: string; error: string } }>(
          'run-local',
          'local-personal'
        )
      ).resolves.toMatchObject({
        run: { status: 'aborted', error: 'Cron run interrupted before completion' }
      })
      await expect(
        repository.cronRunDetail<{ run: { status: string } }>('run-team', 'team-a')
      ).resolves.toMatchObject({ run: { status: 'running' } })
      await expect(repository.cronJob('cron-expired', 'local-personal')).resolves.toMatchObject({
        enabled: 0,
        deleted_at: 10
      })
      await expect(repository.recoverCronJobs('local-personal', 11)).resolves.toMatchObject({
        abortedRuns: 0,
        expiredJobs: 0
      })
      await expect(repository.recoverCronJobs<{ id: string }>('team-a', 11)).resolves.toMatchObject(
        {
          jobs: [expect.objectContaining({ id: 'cron-team' })],
          abortedRuns: 1,
          expiredJobs: 0
        }
      )
    } finally {
      await repository.close()
    }
  })

  it('creates a private, consistent SQLite backup with an auditable manifest', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      ...fixture,
      now: new Date('2026-09-17T00:00:00.000Z')
    })
    expect(snapshot.userVersion).toBe(7)
    expect(snapshot.tables).toEqual([
      'agent_change_sets',
      'agent_file_changes',
      'app_migrations',
      'cron_jobs',
      'cron_run_logs',
      'cron_run_messages',
      'cron_runs',
      'desktop_flow_runs',
      'desktop_flow_steps',
      'desktop_flows',
      'draw_runs',
      'memory_automation_entries',
      'memory_automation_rollups_v2',
      'memory_citation_usage',
      'memory_jobs',
      'memory_roots',
      'memory_stage1_outputs',
      'messages',
      'plans',
      'projects',
      'qq_wakeup_windows_v2',
      'runtime_job_events',
      'runtime_jobs',
      'runtime_tool_results',
      'session_goal_events',
      'session_goals',
      'sessions',
      'ssh_connections',
      'ssh_groups',
      'sub_agent_history',
      'tasks',
      'usage_activity_daily_models_v2',
      'usage_activity_daily_providers_v2',
      'usage_activity_daily_v2',
      'usage_events',
      'wiki_documents',
      'wiki_file_snapshots',
      'wiki_generation_runs',
      'wiki_nodes'
    ])
    expect(snapshot.sourcePath).toBe(fixture.sourcePath)
    expect((await stat(snapshot.backupPath)).mode & 0o777).toBe(0o600)
    expect((await stat(snapshot.rollbackPath)).mode & 0o777).toBe(0o400)
    expect(snapshot.rollbackSize).toBe(snapshot.backupSize)
    expect(snapshot.rollbackSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(await readFile(snapshot.manifestPath, 'utf8'))).toMatchObject({
      sourcePath: fixture.sourcePath,
      backupPath: snapshot.backupPath,
      userVersion: 7,
      tables: [
        'agent_change_sets',
        'agent_file_changes',
        'app_migrations',
        'cron_jobs',
        'cron_run_logs',
        'cron_run_messages',
        'cron_runs',
        'desktop_flow_runs',
        'desktop_flow_steps',
        'desktop_flows',
        'draw_runs',
        'memory_automation_entries',
        'memory_automation_rollups_v2',
        'memory_citation_usage',
        'memory_jobs',
        'memory_roots',
        'memory_stage1_outputs',
        'messages',
        'plans',
        'projects',
        'qq_wakeup_windows_v2',
        'runtime_job_events',
        'runtime_jobs',
        'runtime_tool_results',
        'session_goal_events',
        'session_goals',
        'sessions',
        'ssh_connections',
        'ssh_groups',
        'sub_agent_history',
        'tasks',
        'usage_activity_daily_models_v2',
        'usage_activity_daily_providers_v2',
        'usage_activity_daily_v2',
        'usage_events',
        'wiki_documents',
        'wiki_file_snapshots',
        'wiki_generation_runs',
        'wiki_nodes'
      ]
    })
    const backup = new DatabaseSync(snapshot.backupPath, { readOnly: true })
    try {
      expect(backup.prepare('SELECT content FROM messages WHERE id=?').get('message-1')).toEqual({
        content: 'Preserved'
      })
    } finally {
      backup.close()
    }
  })

  it('rejects a linked or shared backup directory without changing its target permissions', async () => {
    const fixture = await createFixture()
    await symlink(dirname(fixture.sourcePath), fixture.backupDirectory)
    await expect(createLegacyDatabaseHandoverSnapshot(fixture)).rejects.toThrow(
      'LEGACY_DATABASE_BACKUP_DIRECTORY_UNSAFE'
    )
    await rm(fixture.backupDirectory)
    await mkdir(fixture.backupDirectory, { mode: 0o755 })
    await chmod(fixture.backupDirectory, 0o755)
    await expect(createLegacyDatabaseHandoverSnapshot(fixture)).rejects.toThrow(
      'LEGACY_DATABASE_BACKUP_DIRECTORY_UNSAFE'
    )
    expect((await stat(fixture.backupDirectory)).mode & 0o777).toBe(0o755)
  })

  it('detects a write to the parked source after the handover snapshot', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      ...fixture,
      requireQuiescedSource: true
    })
    await expect(verifyQuiescedLegacySourceUnchanged(snapshot)).resolves.toBeUndefined()
    const source = new DatabaseSync(fixture.sourcePath)
    try {
      source.exec("UPDATE sessions SET title='Late write' WHERE id='session-1'")
    } finally {
      source.close()
    }
    await expect(verifyQuiescedLegacySourceUnchanged(snapshot)).rejects.toThrow(
      'LEGACY_DATABASE_SOURCE_CHANGED_DURING_HANDOVER'
    )
  })

  it('rejects a source write during a quiesced handover and removes partial artifacts', async () => {
    const fixture = await createFixture()
    const writer = new DatabaseSync(fixture.sourcePath)
    writer.exec('PRAGMA journal_mode=WAL')
    writer.close()
    let wrote = false
    await expect(
      createLegacyDatabaseHandoverSnapshot({
        ...fixture,
        requireQuiescedSource: true,
        afterBackup: () => {
          if (wrote) return
          wrote = true
          const concurrent = new DatabaseSync(fixture.sourcePath)
          try {
            concurrent
              .prepare('UPDATE sessions SET title=? WHERE id=?')
              .run('Concurrent write', 'session-1')
          } finally {
            concurrent.close()
          }
        }
      })
    ).rejects.toThrow('LEGACY_DATABASE_SOURCE_CHANGED_DURING_HANDOVER')
    expect(wrote).toBe(true)
    expect(await readdir(fixture.backupDirectory)).toEqual([])
  })

  it('reopens a completed handover as a read-only recovery drill', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    await expect(
      verifyLegacyDatabaseHandoverSnapshot({ manifestPath: snapshot.manifestPath })
    ).resolves.toEqual(expect.objectContaining(snapshot))
  })

  it('keeps the handover manifest valid after legitimate TS repository writes', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      for (let index = 0; index < 24; index++) {
        await repository.submitRuntimeJob({
          jobId: `growing-job-${index}`,
          workspaceId: 'local-personal',
          method: 'agent/run',
          paramsJson: JSON.stringify({ text: 'x'.repeat(4000) }),
          createdAt: index + 1
        })
      }
    } finally {
      await repository.close()
    }
    expect((await stat(snapshot.backupPath)).size).toBeGreaterThan(snapshot.backupSize)
    expect((await stat(snapshot.rollbackPath)).size).toBe(snapshot.rollbackSize)
    await expect(
      verifyLegacyDatabaseHandoverSnapshot({ manifestPath: snapshot.manifestPath })
    ).resolves.toEqual(expect.objectContaining({ backupPath: snapshot.backupPath }))
  })

  it('rejects a missing or modified immutable rollback baseline', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    await chmod(snapshot.rollbackPath, 0o600)
    const baseline = new DatabaseSync(snapshot.rollbackPath)
    baseline.exec('PRAGMA user_version=8')
    baseline.close()
    await chmod(snapshot.rollbackPath, 0o400)
    await expect(
      verifyLegacyDatabaseHandoverSnapshot({ manifestPath: snapshot.manifestPath })
    ).rejects.toThrow('LEGACY_DATABASE_ROLLBACK_MISMATCH')
    await rm(snapshot.rollbackPath)
    await expect(
      verifyLegacyDatabaseHandoverSnapshot({ manifestPath: snapshot.manifestPath })
    ).rejects.toThrow('LEGACY_DATABASE_ROLLBACK_UNAVAILABLE')
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await expect(repository.migrationStatus()).rejects.toThrow(
        'BUSINESS_HANDOVER_ROLLBACK_UNAVAILABLE'
      )
    } finally {
      await repository.close()
    }
  })

  it('rejects a recovery artifact after its private backup is removed', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    await rm(snapshot.backupPath)
    await expect(
      verifyLegacyDatabaseHandoverSnapshot({ manifestPath: snapshot.manifestPath })
    ).rejects.toThrow('LEGACY_DATABASE_BACKUP_UNAVAILABLE')
  })

  it('restores the rollback baseline even when the active TS copy is lost', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    await rm(snapshot.backupPath)
    await expect(
      verifyLegacyDatabaseHandoverSnapshot({ manifestPath: snapshot.manifestPath })
    ).rejects.toThrow('LEGACY_DATABASE_BACKUP_UNAVAILABLE')
    const drill = await createLegacyRollbackDrill({
      manifestPath: snapshot.manifestPath,
      restoreDirectory: fixture.backupDirectory
    })
    const restored = new DatabaseSync(drill.restoredPath, { readOnly: true })
    try {
      expect(restored.prepare('SELECT content FROM messages WHERE id=?').get('message-1')).toEqual({
        content: 'Preserved'
      })
    } finally {
      restored.close()
    }
  })

  it('verifies the workspace-scoped legacy business schema before a handover', async () => {
    const fixture = await createFixture()
    await expect(
      verifyLegacyBusinessDatabaseContract({ sourcePath: fixture.sourcePath })
    ).resolves.toMatchObject({
      sourcePath: fixture.sourcePath,
      userVersion: 7,
      tables: [
        'agent_change_sets',
        'agent_file_changes',
        'app_migrations',
        'cron_jobs',
        'cron_run_logs',
        'cron_run_messages',
        'cron_runs',
        'desktop_flow_runs',
        'desktop_flow_steps',
        'desktop_flows',
        'draw_runs',
        'memory_automation_entries',
        'memory_automation_rollups_v2',
        'memory_citation_usage',
        'memory_jobs',
        'memory_roots',
        'memory_stage1_outputs',
        'messages',
        'plans',
        'projects',
        'qq_wakeup_windows_v2',
        'runtime_job_events',
        'runtime_jobs',
        'runtime_tool_results',
        'session_goal_events',
        'session_goals',
        'sessions',
        'ssh_connections',
        'ssh_groups',
        'sub_agent_history',
        'tasks',
        'usage_activity_daily_models_v2',
        'usage_activity_daily_providers_v2',
        'usage_activity_daily_v2',
        'usage_events',
        'wiki_documents',
        'wiki_file_snapshots',
        'wiki_generation_runs',
        'wiki_nodes'
      ]
    })
  })

  it('rejects a legacy schema that lacks the workspace ownership field', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-legacy-handover-invalid-'))
    directories.push(directory)
    const sourcePath = join(directory, 'data.db')
    const database = new DatabaseSync(sourcePath)
    database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)')
    database.close()
    await expect(verifyLegacyBusinessDatabaseContract({ sourcePath })).rejects.toThrow(
      'LEGACY_DATABASE_SCHEMA_UNSUPPORTED:sessions.title'
    )
  })

  it('rejects a memory handover schema without job workspace ownership', async () => {
    const fixture = await createFixture()
    const database = new DatabaseSync(fixture.sourcePath)
    try {
      database.exec('ALTER TABLE memory_jobs DROP COLUMN workspace_id')
    } finally {
      database.close()
    }
    await expect(
      verifyLegacyBusinessDatabaseContract({ sourcePath: fixture.sourcePath })
    ).rejects.toThrow('LEGACY_DATABASE_SCHEMA_UNSUPPORTED:memory_jobs.workspace_id')
  })

  it('rejects a QQ wakeup handover schema missing source ordering', async () => {
    const fixture = await createFixture()
    const database = new DatabaseSync(fixture.sourcePath)
    try {
      database.exec('ALTER TABLE qq_wakeup_windows_v2 DROP COLUMN source_timestamp')
    } finally {
      database.close()
    }
    await expect(
      verifyLegacyBusinessDatabaseContract({ sourcePath: fixture.sourcePath })
    ).rejects.toThrow('LEGACY_DATABASE_SCHEMA_UNSUPPORTED:qq_wakeup_windows_v2.source_timestamp')
  })

  it('updates Goal objective, budget, and status with Native-compatible transitions', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await repository.createGoal({
        sessionId: 'session-1',
        workspaceId: 'local-personal',
        goalId: 'goal-first',
        objective: 'First objective',
        tokenBudget: 10,
        createdAt: 1
      })
      await repository.accountGoalUsage({
        sessionId: 'session-1',
        workspaceId: 'local-personal',
        timeDeltaSeconds: 2,
        tokenDelta: 10,
        updatedAt: 2
      })
      await expect(
        repository.updateGoal<{
          goal_id: string
          status: string
          tokens_used: number
          time_used_seconds: number
          created_at: number
        }>({
          sessionId: 'session-1',
          workspaceId: 'local-personal',
          patch: { objective: 'Second objective' },
          goalId: 'goal-second',
          updatedAt: 3
        })
      ).resolves.toMatchObject({
        goal_id: 'goal-second',
        status: 'active',
        tokens_used: 0,
        time_used_seconds: 0,
        created_at: 3
      })
      await expect(
        repository.updateGoal<{ goal_id: string; status: string; token_budget: number }>({
          sessionId: 'session-1',
          workspaceId: 'local-personal',
          patch: { status: 'paused', tokenBudget: 5 },
          updatedAt: 4
        })
      ).resolves.toMatchObject({ goal_id: 'goal-second', status: 'paused', token_budget: 5 })
      await repository.accountGoalUsage({
        sessionId: 'session-1',
        workspaceId: 'local-personal',
        timeDeltaSeconds: 1,
        tokenDelta: 5,
        updatedAt: 5
      })
      await expect(
        repository.updateGoal<{ goal_id: string; status: string; tokens_used: number }>({
          sessionId: 'session-1',
          workspaceId: 'local-personal',
          patch: { status: 'active', tokenBudget: null },
          updatedAt: 6
        })
      ).resolves.toMatchObject({ goal_id: 'goal-second', status: 'active', tokens_used: 5 })
      const events = await repository.goalEvents<{
        event_type: string
        metadata_json: string | null
      }>('session-1', 'local-personal')
      expect(events.map((event) => event.event_type).sort()).toEqual([
        'budget_limited',
        'budget_limited',
        'budget_updated',
        'budget_updated',
        'created',
        'objective_updated',
        'status_changed',
        'status_changed',
        'status_changed',
        'usage_accounted',
        'usage_accounted'
      ])
      expect(events.find((event) => event.event_type === 'objective_updated')?.metadata_json).toBe(
        '{"previousGoalId":"goal-first","previousObjective":"First objective","status":"active","tokenBudget":10}'
      )
      await expect(
        repository.updateGoal({
          sessionId: 'session-1',
          workspaceId: 'other-workspace',
          patch: { status: 'blocked' }
        })
      ).rejects.toThrow('BUSINESS_SESSION_NOT_FOUND')
    } finally {
      await repository.close()
    }
  })

  it('creates and replaces Goals atomically while retaining history and resetting usage', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await expect(
        repository.createGoal({
          sessionId: 'session-1',
          workspaceId: 'other-workspace',
          objective: 'Denied'
        })
      ).rejects.toThrow('BUSINESS_SESSION_NOT_FOUND')
      await expect(
        repository.createGoal({
          sessionId: 'session-1',
          workspaceId: 'local-personal',
          objective: 'Invalid budget',
          tokenBudget: 0
        })
      ).rejects.toThrow('BUSINESS_GOAL_BUDGET_INVALID')
      await expect(
        repository.createGoal<{
          goal_id: string
          tokens_used: number
          status: string
        }>({
          sessionId: 'session-1',
          workspaceId: 'local-personal',
          goalId: 'goal-created',
          objective: 'Create',
          tokenBudget: 10,
          createdAt: 5
        })
      ).resolves.toMatchObject({ goal_id: 'goal-created', tokens_used: 0, status: 'active' })
      await expect(
        repository.createGoal({
          sessionId: 'session-1',
          workspaceId: 'local-personal',
          goalId: 'goal-duplicate',
          objective: 'Do not replace'
        })
      ).resolves.toBeNull()
      await repository.accountGoalUsage({
        sessionId: 'session-1',
        workspaceId: 'local-personal',
        timeDeltaSeconds: 3,
        tokenDelta: 4,
        updatedAt: 6
      })
      await expect(
        repository.replaceGoal<{
          goal_id: string
          tokens_used: number
          time_used_seconds: number
          created_at: number
        }>({
          sessionId: 'session-1',
          workspaceId: 'local-personal',
          goalId: 'goal-replaced',
          objective: 'Replace',
          status: 'paused',
          createdAt: 10
        })
      ).resolves.toMatchObject({
        goal_id: 'goal-replaced',
        tokens_used: 0,
        time_used_seconds: 0,
        created_at: 10
      })
      const events = await repository.goalEvents<{
        event_type: string
        metadata_json: string | null
      }>('session-1', 'local-personal')
      expect(events.map((event) => event.event_type).sort()).toEqual([
        'created',
        'replaced',
        'usage_accounted'
      ])
      expect(events.find((event) => event.event_type === 'created')?.metadata_json).toBe(
        '{"tokenBudget":10}'
      )
      expect(events.find((event) => event.event_type === 'replaced')?.metadata_json).toBe(
        '{"status":"paused","tokenBudget":null}'
      )
    } finally {
      await repository.close()
    }
  })

  it('accounts Goal usage atomically with expected-ID and budget transition events', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await repository.upsertGoal({
        sessionId: 'session-1',
        workspaceId: 'local-personal',
        goalId: 'goal-account',
        objective: 'Finish migration',
        status: 'active',
        tokenBudget: 10,
        createdAt: 1,
        updatedAt: 1
      })
      const usage = (tokenDelta: number, expectedGoalId = 'goal-account') =>
        repository.accountGoalUsage<{
          tokens_used: number
          time_used_seconds: number
          status: string
        }>({
          sessionId: 'session-1',
          workspaceId: 'local-personal',
          expectedGoalId,
          timeDeltaSeconds: 2,
          tokenDelta,
          updatedAt: 100 + tokenDelta
        })
      await expect(usage(5, 'stale-goal')).resolves.toBeNull()
      await expect(
        repository.accountGoalUsage({
          sessionId: 'session-1',
          workspaceId: 'local-personal',
          expectedGoalId: 'stale-goal',
          timeDeltaSeconds: -1,
          tokenDelta: -1
        })
      ).resolves.toMatchObject({ tokens_used: 0, time_used_seconds: 0 })
      await expect(repository.goalEvents('session-1', 'local-personal')).resolves.toEqual([])
      await expect(usage(5)).resolves.toMatchObject({
        tokens_used: 5,
        time_used_seconds: 2,
        status: 'active'
      })
      await expect(usage(5)).resolves.toMatchObject({
        tokens_used: 10,
        time_used_seconds: 4,
        status: 'budget_limited'
      })
      await expect(usage(1)).resolves.toMatchObject({ tokens_used: 11, status: 'budget_limited' })
      const events = await repository.goalEvents<{
        event_type: string
        metadata_json: string | null
      }>('session-1', 'local-personal')
      expect(events.map((event) => event.event_type).sort()).toEqual([
        'budget_limited',
        'usage_accounted',
        'usage_accounted',
        'usage_accounted'
      ])
      expect(events.find((event) => event.event_type === 'budget_limited')?.metadata_json).toBe(
        '{"tokenBudget":10,"tokensUsed":10}'
      )
      await expect(repository.goalEvents('session-1', 'other-workspace')).resolves.toEqual([])
      await expect(
        repository.accountGoalUsage({
          sessionId: 'session-1',
          workspaceId: 'other-workspace',
          timeDeltaSeconds: 1,
          tokenDelta: 1
        })
      ).rejects.toThrow('BUSINESS_SESSION_NOT_FOUND')
    } finally {
      await repository.close()
    }
  })

  it('opens only a verified handover copy through the TS-owned single-worker repository', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await expect(repository.migrationStatus()).resolves.toEqual([
        expect.objectContaining({
          version: 1,
          description: 'verified legacy business schema ownership'
        }),
        expect.objectContaining({
          version: 2,
          description: 'workspace-scoped sync baseline and tombstones'
        }),
        expect.objectContaining({
          version: 3,
          description: 'workspace ownership for project wiki tables'
        })
      ])
      const competingRepository = new BusinessRepository({
        path: snapshot.backupPath,
        handoverManifestPath: snapshot.manifestPath
      })
      try {
        await expect(competingRepository.migrationStatus()).rejects.toThrow(
          'BUSINESS_DATABASE_LOCKED'
        )
      } finally {
        await competingRepository.close()
      }
      await expect(repository.sessions<{ id: string }>('local-personal')).resolves.toEqual([
        {
          id: 'session-1',
          title: 'Legacy',
          icon: null,
          mode: 'chat',
          created_at: 1,
          updated_at: 1,
          message_count: 1,
          project_id: null,
          working_folder: null,
          ssh_connection_id: null,
          plan_id: null,
          pinned: 0,
          plugin_id: null,
          external_chat_id: null,
          provider_id: null,
          model_id: null,
          model_selection_mode: 'inherit',
          model_source: null,
          workspace_id: 'local-personal'
        }
      ])
      await expect(repository.sessions('other-workspace')).resolves.toEqual([])
      await expect(
        repository.cronJobs<{ id: string; workspace_id: string }>('local-personal')
      ).resolves.toEqual([
        expect.objectContaining({ id: 'cron-1', workspace_id: 'local-personal' })
      ])
      await expect(repository.cronJobs('other-workspace')).resolves.toEqual([])
      await expect(repository.cronJob('cron-1', 'other-workspace')).resolves.toBeNull()
      await expect(
        repository.cronJob<{ id: string }>('cron-1', 'local-personal')
      ).resolves.toMatchObject({ id: 'cron-1' })
      await expect(
        repository.createCronJob({
          id: 'cron-ts',
          workspaceId: 'other-workspace',
          name: 'Wrong workspace',
          scheduleKind: 'every',
          scheduleEvery: 60_000,
          prompt: 'Never persist',
          sessionId: 'session-1',
          createdAt: 2
        })
      ).rejects.toThrow('BUSINESS_CRON_SESSION_NOT_FOUND')
      await expect(
        repository.createCronJob({
          id: 'cron-ts',
          workspaceId: 'local-personal',
          name: 'Wrong model workspace',
          scheduleKind: 'every',
          scheduleEvery: 60_000,
          prompt: 'Never persist',
          modelSource: JSON.stringify({
            kind: 'ola-team',
            workspaceId: 'other-workspace',
            resourceId: 'team-model'
          }),
          createdAt: 2
        })
      ).rejects.toThrow('INVALID_BUSINESS_CRON_MODEL_SOURCE')
      await expect(
        repository.createCronJob({
          id: 'cron-ts',
          workspaceId: 'local-personal',
          name: 'Wrong source provider workspace',
          scheduleKind: 'every',
          scheduleEvery: 60_000,
          prompt: 'Never persist',
          sourceProviderId: 'ola-managed:other-workspace',
          createdAt: 2
        })
      ).rejects.toThrow('INVALID_BUSINESS_CRON_SOURCE_PROVIDER')
      await expect(
        repository.createCronJob({
          id: 'cron-ts',
          workspaceId: 'local-personal',
          name: 'TS cron',
          scheduleKind: 'every',
          scheduleEvery: 60_000,
          prompt: 'Run from the copied database',
          sessionId: 'session-1',
          createdAt: 2
        })
      ).resolves.toBe(true)
      await expect(
        repository.updateCronJob({
          id: 'cron-ts',
          workspaceId: 'other-workspace',
          updatedAt: 3,
          patch: { name: 'Cross workspace' }
        })
      ).rejects.toThrow('BUSINESS_CRON_JOB_NOT_FOUND')
      await expect(
        repository.updateCronJob({
          id: 'cron-ts',
          workspaceId: 'local-personal',
          updatedAt: 3,
          patch: {
            modelSource: JSON.stringify({
              kind: 'ola-team',
              workspaceId: 'other-workspace',
              resourceId: 'team-model'
            })
          }
        })
      ).rejects.toThrow('INVALID_BUSINESS_CRON_MODEL_SOURCE')
      await expect(
        repository.updateCronJob({
          id: 'cron-ts',
          workspaceId: 'local-personal',
          updatedAt: 3,
          patch: { sourceProviderId: 'ola-managed:other-workspace' }
        })
      ).rejects.toThrow('INVALID_BUSINESS_CRON_SOURCE_PROVIDER')
      await expect(
        repository.updateCronJob({
          id: 'cron-ts',
          workspaceId: 'local-personal',
          updatedAt: 3,
          patch: { name: 'TS cron updated', scheduleKind: 'at', scheduleAt: 10 }
        })
      ).resolves.toBe(true)
      await expect(
        repository.cronJobs<{ id: string; name: string; schedule_kind: string }>('local-personal')
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'cron-ts', name: 'TS cron updated', schedule_kind: 'at' })
        ])
      )
      await expect(
        repository.deleteCronJob({ id: 'cron-ts', workspaceId: 'other-workspace' })
      ).rejects.toThrow('BUSINESS_CRON_JOB_NOT_FOUND')
      await expect(
        repository.deleteCronJob({ id: 'cron-ts', workspaceId: 'local-personal' })
      ).resolves.toBe(true)
      await expect(
        repository.createCronRun({
          id: 'cron-run-2',
          jobId: 'cron-1',
          workspaceId: 'local-personal',
          startedAt: 2,
          jobNameSnapshot: 'Run-time title'
        })
      ).resolves.toBe(true)
      await expect(
        repository.cronRunDetail<{ run: { job_name_snapshot: string; prompt_snapshot: string } }>(
          'cron-run-2',
          'local-personal'
        )
      ).resolves.toMatchObject({
        run: { job_name_snapshot: 'Run-time title', prompt_snapshot: 'Preserved' }
      })
      await expect(
        repository.replaceCronRunMessages({
          runId: 'cron-run-2',
          workspaceId: 'other-workspace',
          messages: []
        })
      ).rejects.toThrow('BUSINESS_CRON_RUN_NOT_FOUND')
      await expect(
        repository.replaceCronRunMessages({
          runId: 'cron-run-2',
          workspaceId: 'local-personal',
          messages: [
            {
              id: 'cron-message-2',
              role: 'assistant',
              content: JSON.stringify('TS reply'),
              createdAt: 2
            }
          ]
        })
      ).resolves.toBe(true)
      await expect(
        repository.replaceCronRunMessages({
          runId: 'cron-run-2',
          workspaceId: 'local-personal',
          messages: [{ id: 'cron-message-invalid', role: 'assistant', content: '{', createdAt: 3 }]
        })
      ).rejects.toThrow('INVALID_BUSINESS_CRON_CONTENT')
      await expect(
        repository.appendCronRunLog({
          id: 'cron-log-2',
          runId: 'cron-run-2',
          workspaceId: 'other-workspace',
          timestamp: 2,
          type: 'start',
          content: 'Never append'
        })
      ).rejects.toThrow('BUSINESS_CRON_RUN_NOT_FOUND')
      await expect(
        repository.appendCronRunLog({
          id: 'cron-log-2',
          runId: 'cron-run-2',
          workspaceId: 'local-personal',
          timestamp: 2,
          type: 'start',
          content: 'TS started'
        })
      ).resolves.toBe(true)
      await expect(
        repository.cronRunDetail<{
          messages: Array<{ content: string }>
          logs: Array<{ content: string }>
        }>('cron-run-2', 'local-personal')
      ).resolves.toMatchObject({
        messages: [expect.objectContaining({ content: JSON.stringify('TS reply') })],
        logs: [expect.objectContaining({ content: 'TS started' })]
      })
      await expect(
        repository.finishCronRun({
          id: 'cron-run-2',
          workspaceId: 'other-workspace',
          finishedAt: 3,
          status: 'success',
          toolCallCount: 1
        })
      ).rejects.toThrow('BUSINESS_CRON_RUN_NOT_FOUND')
      await expect(
        repository.finishCronRun({
          id: 'cron-run-2',
          workspaceId: 'local-personal',
          finishedAt: 3,
          status: 'success',
          toolCallCount: 1,
          outputSummary: 'TS done'
        })
      ).resolves.toBe(true)
      await expect(
        repository.finishCronRun({
          id: 'cron-run-2',
          workspaceId: 'local-personal',
          finishedAt: 4,
          status: 'error',
          toolCallCount: 1
        })
      ).rejects.toThrow('BUSINESS_CRON_RUN_NOT_FOUND')
      await expect(
        repository.markCronJobFired({
          id: 'cron-1',
          workspaceId: 'other-workspace',
          firedAt: 3
        })
      ).rejects.toThrow('BUSINESS_CRON_JOB_NOT_FOUND')
      await expect(
        repository.markCronJobFired({ id: 'cron-1', workspaceId: 'local-personal', firedAt: 3 })
      ).resolves.toBe(true)
      await expect(
        repository.cronJobs<{ last_fired_at: number; fire_count: number }>('local-personal')
      ).resolves.toEqual([expect.objectContaining({ last_fired_at: 3, fire_count: 1 })])
      await expect(
        repository.setCronJobEnabled({
          id: 'cron-1',
          workspaceId: 'local-personal',
          enabled: false,
          updatedAt: 4
        })
      ).resolves.toBe(true)
      await expect(
        repository.markCronJobFired({ id: 'cron-1', workspaceId: 'local-personal', firedAt: 5 })
      ).rejects.toThrow('BUSINESS_CRON_JOB_NOT_FOUND')
      await expect(
        repository.softDeleteCronJob({ id: 'cron-1', workspaceId: 'local-personal', deletedAt: 5 })
      ).resolves.toBe(true)
      await expect(repository.cronJobs('local-personal')).resolves.toEqual([])
      await expect(
        repository.cronJobs<{ deleted_at: number; enabled: number }>('local-personal', {
          includeDeleted: true
        })
      ).resolves.toEqual([expect.objectContaining({ deleted_at: 5, enabled: 0 })])
      await expect(
        repository.cronRuns<{ id: string; job_id: string }>('local-personal')
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'cron-run-1', job_id: 'cron-1' }),
          expect.objectContaining({ id: 'cron-run-2', job_id: 'cron-1' })
        ])
      )
      await expect(repository.cronRuns('other-workspace')).resolves.toEqual([])
      await expect(
        repository.cronRunDetail<{
          messages: Array<{ content: string }>
          logs: Array<{ content: string }>
        }>('cron-run-1', 'local-personal')
      ).resolves.toMatchObject({
        messages: [expect.objectContaining({ content: 'Done' })],
        logs: [expect.objectContaining({ content: 'success' })]
      })
      await expect(repository.cronRunDetail('cron-run-1', 'other-workspace')).resolves.toBeNull()
      await expect(
        repository.messages<{ id: string }>('session-1', 'other-workspace')
      ).resolves.toEqual([])
      await expect(
        repository.createSession<{ id: string; workspace_id: string }>({
          id: 'session-2',
          title: 'TS owned',
          mode: 'chat',
          createdAt: 2,
          updatedAt: 2,
          workspaceId: 'local-personal'
        })
      ).resolves.toMatchObject({ id: 'session-2', workspace_id: 'local-personal' })
      await expect(
        repository.upsertMessage({
          id: 'message-2',
          sessionId: 'session-2',
          workspaceId: 'local-personal',
          role: 'user',
          content: 'TS write',
          createdAt: 2,
          updatedAt: 3,
          sortOrder: 1
        })
      ).resolves.toBe(true)
      await expect(
        repository.upsertMessage({
          id: 'message-3',
          sessionId: 'session-2',
          workspaceId: 'local-personal',
          role: 'assistant',
          content: '[Context Memory Compressed Summary] TS summary',
          createdAt: 3,
          updatedAt: 3,
          sortOrder: 2
        })
      ).resolves.toBe(true)
      await expect(
        repository.messages<{ content: string }>('session-2', 'local-personal')
      ).resolves.toEqual([
        expect.objectContaining({ content: 'TS write' }),
        expect.objectContaining({ content: '[Context Memory Compressed Summary] TS summary' })
      ])
      await expect(
        repository.userMessages<{ id: string }>('session-2', 'local-personal')
      ).resolves.toEqual([expect.objectContaining({ id: 'message-2' })])
      await expect(repository.userMessages('session-2', 'other-workspace')).resolves.toEqual([])
      await expect(
        repository.messageLocatorRows<{ id: string }>('session-2', 'local-personal')
      ).resolves.toEqual([
        expect.objectContaining({ id: 'message-2' }),
        expect.objectContaining({ id: 'message-3' })
      ])
      await expect(repository.messageLocatorRows('session-2', 'other-workspace')).resolves.toEqual(
        []
      )
      await expect(
        repository.messageMarkers<{ id: string; usage: null }>('session-2', 'local-personal')
      ).resolves.toEqual([
        expect.objectContaining({ id: 'message-2', usage: null }),
        expect.objectContaining({ id: 'message-3', usage: null })
      ])
      await expect(repository.messageMarkers('session-2', 'other-workspace')).resolves.toEqual([])
      await expect(
        repository.messagesPage<{ content: string }>('session-2', 'local-personal', 1, 0)
      ).resolves.toEqual([expect.objectContaining({ content: 'TS write' })])
      await expect(repository.messagesPage('session-2', 'other-workspace')).resolves.toEqual([])
      await expect(repository.messageCount('session-2', 'local-personal')).resolves.toBe(2)
      await expect(repository.messageCount('session-2', 'other-workspace')).resolves.toBe(0)
      await expect(
        repository.messageWindowAround<{ id: string }>('session-2', 'local-personal', {
          messageId: 'message-2',
          limit: 30
        })
      ).resolves.toMatchObject({
        success: true,
        rows: [{ id: 'message-2' }, { id: 'message-3' }],
        total: 2
      })
      await expect(
        repository.messageWindowAround('session-2', 'other-workspace', { limit: 30 })
      ).resolves.toMatchObject({ success: true, rows: [], total: 0 })
      await expect(
        repository.messageRequestContext<{ id: string }>('session-2', 'local-personal', 1)
      ).resolves.toEqual([expect.objectContaining({ id: 'message-3' })])
      await expect(
        repository.messageRequestContext('session-2', 'other-workspace', 1)
      ).resolves.toEqual([])
      await expect(
        repository.searchMessageContent<{ session_id: string; snippet: string }>(
          'summary',
          'local-personal'
        )
      ).resolves.toEqual([
        expect.objectContaining({
          session_id: 'session-2',
          snippet: expect.stringContaining('summary')
        })
      ])
      await expect(repository.searchMessageContent('summary', 'other-workspace')).resolves.toEqual(
        []
      )
      await expect(repository.searchMessageContent('%', 'local-personal')).resolves.toEqual([])
      await expect(repository.searchMessageContent('', 'local-personal')).rejects.toThrow(
        'INVALID_BUSINESS_QUERY'
      )
      await expect(
        repository.createProject<{ id: string; workspace_id: string }>({
          id: 'project-2',
          name: 'TS project',
          workspaceId: 'local-personal',
          pluginId: 'plugin-2',
          createdAt: 3,
          updatedAt: 3
        })
      ).resolves.toMatchObject({ id: 'project-2', workspace_id: 'local-personal' })
      await expect(
        repository.project<{ id: string; workspace_id: string }>('project-2', 'local-personal')
      ).resolves.toEqual(
        expect.objectContaining({ id: 'project-2', workspace_id: 'local-personal' })
      )
      await expect(repository.project('project-2', 'other-workspace')).resolves.toBeNull()
      await expect(
        repository.projectByPlugin<{ id: string; workspace_id: string }>(
          'plugin-2',
          'local-personal'
        )
      ).resolves.toEqual(
        expect.objectContaining({ id: 'project-2', workspace_id: 'local-personal' })
      )
      await expect(repository.projectByPlugin('plugin-2', 'other-workspace')).resolves.toBeNull()
      await expect(
        repository.createPlan<{ id: string; session_id: string }>({
          id: 'plan-2',
          sessionId: 'session-2',
          workspaceId: 'local-personal',
          title: 'TS plan',
          createdAt: 3,
          updatedAt: 3,
          spec: { version: 1 }
        })
      ).resolves.toMatchObject({ id: 'plan-2', session_id: 'session-2' })
      await expect(
        repository.planBySession<{ id: string }>('session-2', 'local-personal')
      ).resolves.toMatchObject({ id: 'plan-2' })
      await expect(repository.planBySession('session-2', 'other-workspace')).resolves.toBeNull()
      await expect(repository.planBySession('session-1', 'local-personal')).resolves.toBeNull()
      await repository.createPlan({
        id: 'plan-3',
        sessionId: 'session-2',
        workspaceId: 'local-personal',
        title: 'Latest plan',
        createdAt: 4,
        updatedAt: 4
      })
      await expect(
        repository.planBySession<{ id: string }>('session-2', 'local-personal')
      ).resolves.toMatchObject({ id: 'plan-3' })
      await repository.deletePlan({ id: 'plan-3', workspaceId: 'local-personal' })
      await expect(
        repository.upsertGoal<{ goal_id: string; tokens_used: number }>({
          sessionId: 'session-2',
          workspaceId: 'local-personal',
          goalId: 'goal-2',
          objective: 'Migrate Ola',
          status: 'active',
          tokenBudget: 100,
          tokensUsed: 10,
          timeUsedSeconds: 20,
          createdAt: 3,
          updatedAt: 3
        })
      ).resolves.toMatchObject({ goal_id: 'goal-2', tokens_used: 10 })
      await expect(
        repository.appendGoalEvent({
          id: 'goal-event-2',
          sessionId: 'session-2',
          workspaceId: 'local-personal',
          eventType: 'progress',
          message: 'Started',
          createdAt: 3,
          metadata: { step: 1 }
        })
      ).resolves.toBe(true)
      await expect(
        repository.goalEvents<{ event_type: string }>('session-2', 'local-personal')
      ).resolves.toEqual([expect.objectContaining({ event_type: 'progress' })])
      await expect(repository.goalEvents('session-2', 'other-workspace')).resolves.toEqual([])
      await expect(
        repository.deleteGoal({ sessionId: 'session-2', workspaceId: 'other-workspace' })
      ).rejects.toThrow('BUSINESS_SESSION_NOT_FOUND')
      await expect(
        repository.deleteGoal({ sessionId: 'session-2', workspaceId: 'local-personal' })
      ).resolves.toBe(true)
      await expect(
        repository.goalEvents<{ event_type: string }>('session-2', 'local-personal')
      ).resolves.toEqual([
        expect.objectContaining({ event_type: 'cleared', goal_id: 'goal-2' }),
        expect.objectContaining({ event_type: 'progress', goal_id: null })
      ])
      await expect(
        repository.appendGoalEvent({
          id: 'goal-event-after-clear',
          sessionId: 'session-2',
          workspaceId: 'local-personal',
          eventType: 'completion_deferred',
          createdAt: Date.now() + 1000
        })
      ).resolves.toBe(true)
      await expect(
        repository.goalEvents<{ event_type: string }>('session-2', 'local-personal')
      ).resolves.toEqual([
        expect.objectContaining({ event_type: 'completion_deferred', goal_id: null }),
        expect.objectContaining({ event_type: 'cleared', goal_id: 'goal-2' }),
        expect.objectContaining({ event_type: 'progress', goal_id: null })
      ])
      await expect(repository.goalEvents('session-2', 'other-workspace')).resolves.toEqual([])
      await expect(
        repository.appendGoalEvent({
          id: 'goal-event-cross-space',
          sessionId: 'session-2',
          workspaceId: 'other-workspace',
          eventType: 'completion_deferred',
          createdAt: Date.now() + 1000
        })
      ).rejects.toThrow('BUSINESS_SESSION_NOT_FOUND')
      await expect(
        repository.createTask({
          id: 'task-invalid-plan',
          sessionId: 'session-1',
          workspaceId: 'local-personal',
          planId: 'plan-2',
          subject: 'Invalid reference',
          description: 'A plan cannot cross sessions',
          sortOrder: 1,
          createdAt: 3,
          updatedAt: 3
        })
      ).rejects.toThrow('BUSINESS_PLAN_NOT_FOUND')
      await expect(
        repository.createTask({
          id: 'task-2',
          sessionId: 'session-2',
          workspaceId: 'local-personal',
          planId: 'plan-2',
          subject: 'Migrate',
          description: 'Own this task',
          sortOrder: 1,
          createdAt: 3,
          updatedAt: 3
        })
      ).resolves.toBe(true)
      await expect(repository.tasks<{ id: string }>('local-personal')).resolves.toEqual([
        expect.objectContaining({ id: 'task-2', session_id: 'session-2' })
      ])
      await expect(
        repository.tasksBySession<{ id: string }>('session-2', 'local-personal')
      ).resolves.toEqual([expect.objectContaining({ id: 'task-2' })])
      await expect(repository.tasksBySession('session-2', 'other-workspace')).resolves.toEqual([])
      await expect(repository.task<{ id: string }>('task-2', 'local-personal')).resolves.toEqual(
        expect.objectContaining({ id: 'task-2' })
      )
      await expect(repository.task('task-2', 'other-workspace')).resolves.toBeNull()
      await expect(
        repository.updatePlan<{ title: string; status: string }>({
          id: 'plan-2',
          workspaceId: 'local-personal',
          title: 'Updated plan',
          status: 'approved',
          updatedAt: 4
        })
      ).resolves.toMatchObject({ title: 'Updated plan', status: 'approved' })
      await expect(
        repository.deletePlan({ id: 'plan-2', workspaceId: 'other-workspace' })
      ).rejects.toThrow('BUSINESS_PLAN_NOT_FOUND')
      await expect(
        repository.deletePlan({ id: 'plan-2', workspaceId: 'local-personal' })
      ).resolves.toBe(true)
      await expect(repository.tasks<{ plan_id: string | null }>('local-personal')).resolves.toEqual(
        [expect.objectContaining({ plan_id: null })]
      )
      await expect(
        repository.updateSession<{ title: string; pinned: number }>({
          id: 'session-2',
          workspaceId: 'local-personal',
          title: 'Updated by TS',
          pinned: true,
          projectId: 'project-2',
          updatedAt: 4
        })
      ).resolves.toMatchObject({ title: 'Updated by TS', pinned: 1 })
      await expect(
        repository.deleteProject({ id: 'project-2', workspaceId: 'local-personal' })
      ).rejects.toThrow('BUSINESS_PROJECT_IN_USE')
      await expect(
        repository.updateProject<{ name: string; pinned: number }>({
          id: 'project-2',
          workspaceId: 'local-personal',
          name: 'Updated TS project',
          pinned: true,
          updatedAt: 4
        })
      ).resolves.toMatchObject({ name: 'Updated TS project', pinned: 1 })
      await expect(
        repository.updateTask({
          id: 'task-2',
          workspaceId: 'local-personal',
          subject: 'Migrated',
          status: 'in_progress',
          blocks: ['task-1'],
          updatedAt: 4
        })
      ).resolves.toBe(true)
      await expect(repository.tasks<{ subject: string }>('local-personal')).resolves.toEqual([
        expect.objectContaining({ subject: 'Migrated' })
      ])
      await expect(
        repository.deleteMessage({
          id: 'message-2',
          sessionId: 'session-2',
          workspaceId: 'local-personal',
          updatedAt: 5
        })
      ).resolves.toBe(true)
      await expect(
        repository.session<{ message_count: number }>('session-2', 'local-personal')
      ).resolves.toMatchObject({ message_count: 1 })
      await expect(
        repository.deleteTask({ id: 'task-2', workspaceId: 'other-workspace' })
      ).rejects.toThrow('BUSINESS_TASK_NOT_FOUND')
      await repository.createSession({
        id: 'team-session-for-task-delete',
        title: 'Team task owner',
        mode: 'chat',
        createdAt: 4,
        updatedAt: 4,
        workspaceId: 'team-a'
      })
      await repository.createTask({
        id: 'team-task-for-task-delete',
        sessionId: 'team-session-for-task-delete',
        workspaceId: 'team-a',
        subject: 'Preserve team task',
        description: 'Belongs to a different workspace',
        sortOrder: 0,
        createdAt: 4,
        updatedAt: 4
      })
      await expect(
        repository.deleteTasksBySession({ sessionId: 'session-2', workspaceId: 'other-workspace' })
      ).rejects.toThrow('BUSINESS_SESSION_NOT_FOUND')
      await expect(
        repository.deleteTasksBySession({ sessionId: 'session-2', workspaceId: 'local-personal' })
      ).resolves.toBe(1)
      await expect(
        repository.deleteTasksBySession({ sessionId: 'session-2', workspaceId: 'local-personal' })
      ).resolves.toBe(0)
      await expect(repository.tasksBySession('session-2', 'local-personal')).resolves.toEqual([])
      await expect(
        repository.tasksBySession('team-session-for-task-delete', 'team-a')
      ).resolves.toEqual([expect.objectContaining({ id: 'team-task-for-task-delete' })])
      await expect(
        repository.deleteMessage({
          id: 'message-2',
          sessionId: 'session-2',
          workspaceId: 'other-workspace',
          updatedAt: 5
        })
      ).rejects.toThrow('BUSINESS_SESSION_NOT_FOUND')
      await expect(
        repository.deleteSession({ id: 'session-2', workspaceId: 'local-personal' })
      ).resolves.toBe(true)
      await expect(repository.messages('session-2', 'local-personal')).resolves.toEqual([])
      await expect(repository.tasks('local-personal')).resolves.toEqual([])
      await expect(repository.plans('local-personal')).resolves.toEqual([])
      await expect(repository.goals('local-personal')).resolves.toEqual([])
      await expect(
        repository.deleteProject({ id: 'project-2', workspaceId: 'local-personal' })
      ).resolves.toBe(true)
    } finally {
      await repository.close()
    }
  })

  it('resets only the requested workspace conversation without deleting its session', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await repository.createSession({
        id: 'team-reset-session',
        title: 'Team before reset',
        mode: 'chat',
        createdAt: 2,
        updatedAt: 2,
        workspaceId: 'team-a'
      })
      await repository.upsertMessage({
        id: 'team-reset-message',
        sessionId: 'team-reset-session',
        workspaceId: 'team-a',
        role: 'user',
        content: 'Team history',
        createdAt: 2,
        updatedAt: 2,
        sortOrder: 0
      })
      await expect(
        repository.resetConversation({
          sessionId: 'team-reset-session',
          workspaceId: 'local-personal'
        })
      ).rejects.toThrow('BUSINESS_SESSION_NOT_FOUND')
      await expect(repository.messages('team-reset-session', 'team-a')).resolves.toHaveLength(1)
      await expect(
        repository.resetConversation({ sessionId: 'team-reset-session', workspaceId: 'team-a' })
      ).resolves.toMatchObject({ success: true, deletedMessages: 1 })
      await expect(repository.messages('team-reset-session', 'team-a')).resolves.toEqual([])
      await expect(
        repository.session<{ title: string; message_count: number }>('team-reset-session', 'team-a')
      ).resolves.toMatchObject({ title: 'New Conversation', message_count: 0 })
      await expect(repository.messages('session-1', 'local-personal')).resolves.toHaveLength(1)
      await expect(
        repository.resetConversation({ sessionId: 'team-reset-session', workspaceId: 'team-a' })
      ).resolves.toMatchObject({ success: true, deletedMessages: 0 })
    } finally {
      await repository.close()
    }
  })

  it('clears only non-plugin sessions in the requested workspace', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await repository.createSession({
        id: 'plugin-session',
        title: 'Plugin',
        mode: 'chat',
        pluginId: 'plugin-a',
        createdAt: 2,
        updatedAt: 2,
        workspaceId: 'local-personal'
      })
      await repository.createSession({
        id: 'team-session',
        title: 'Team',
        mode: 'chat',
        createdAt: 2,
        updatedAt: 2,
        workspaceId: 'team-a'
      })
      for (const [id, sessionId, workspaceId] of [
        ['plugin-message', 'plugin-session', 'local-personal'],
        ['team-message', 'team-session', 'team-a']
      ]) {
        await repository.upsertMessage({
          id,
          sessionId,
          workspaceId,
          role: 'user',
          content: id,
          createdAt: 2,
          updatedAt: 2,
          sortOrder: 0
        })
      }
      await expect(repository.clearAllSessions('local-personal')).resolves.toEqual({
        success: true,
        sessionIds: ['session-1'],
        deletedMessages: 1,
        deletedSessions: 1,
        error: null
      })
      await expect(repository.session('session-1', 'local-personal')).resolves.toBeNull()
      await expect(repository.session('plugin-session', 'local-personal')).resolves.not.toBeNull()
      await expect(repository.session('team-session', 'team-a')).resolves.not.toBeNull()
      await expect(repository.messages('plugin-session', 'local-personal')).resolves.toHaveLength(1)
      await expect(repository.messages('team-session', 'team-a')).resolves.toHaveLength(1)
      await expect(repository.clearAllSessions('local-personal')).resolves.toMatchObject({
        sessionIds: [],
        deletedMessages: 0,
        deletedSessions: 0
      })
    } finally {
      await repository.close()
    }
  })

  it('refuses to open a database without the handover manifest binding', async () => {
    const fixture = await createFixture()
    const repository = new BusinessRepository({
      path: fixture.sourcePath,
      handoverManifestPath: join(fixture.backupDirectory, 'missing.manifest.json')
    })
    try {
      await expect(repository.migrationStatus()).rejects.toThrow(
        'BUSINESS_HANDOVER_MANIFEST_INVALID'
      )
    } finally {
      await repository.close()
    }
  })

  it('rejects a forged handover that points the TS writer at the legacy source', async () => {
    const fixture = await createFixture()
    const snapshot = await createLegacyDatabaseHandoverSnapshot(fixture)
    const forgedManifestPath = `${fixture.sourcePath}.manifest.json`
    await writeFile(
      forgedManifestPath,
      JSON.stringify({
        ...snapshot,
        backupPath: fixture.sourcePath,
        manifestPath: forgedManifestPath
      })
    )
    await expect(
      verifyLegacyDatabaseHandoverSnapshot({ manifestPath: forgedManifestPath })
    ).rejects.toThrow('LEGACY_DATABASE_HANDOVER_MANIFEST_INVALID')
    const repository = new BusinessRepository({
      path: fixture.sourcePath,
      handoverManifestPath: forgedManifestPath
    })
    try {
      await expect(repository.migrationStatus()).rejects.toThrow(
        'BUSINESS_HANDOVER_MANIFEST_INVALID'
      )
    } finally {
      await repository.close()
    }
    const source = new DatabaseSync(fixture.sourcePath, { readOnly: true })
    try {
      expect(source.prepare('SELECT content FROM messages WHERE id=?').get('message-1')).toEqual({
        content: 'Preserved'
      })
    } finally {
      source.close()
    }
  })

  it('rejects a direct backup request when the source is outside the handover schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-legacy-handover-invalid-direct-'))
    directories.push(directory)
    const sourcePath = join(directory, 'data.db')
    const database = new DatabaseSync(sourcePath)
    database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)')
    database.close()
    await expect(
      createLegacyDatabaseHandoverSnapshot({
        sourcePath,
        backupDirectory: join(directory, 'backups')
      })
    ).rejects.toThrow('LEGACY_DATABASE_SCHEMA_UNSUPPORTED:sessions.title')
  })

  it('rejects a handover path that is a symlink to the live legacy database', async () => {
    const fixture = await createFixture()
    const aliasPath = join(fixture.sourcePath, '..', 'live-alias.db')
    await symlink(fixture.sourcePath, aliasPath)
    const manifestPath = `${aliasPath}.manifest.json`
    await writeFile(
      manifestPath,
      JSON.stringify({
        sourcePath: fixture.sourcePath,
        backupPath: aliasPath,
        rollbackPath: `${aliasPath}.rollback.db`,
        manifestPath,
        createdAt: new Date().toISOString(),
        sourceSize: 0,
        backupSize: 0,
        rollbackSize: 0,
        rollbackSha256: '0'.repeat(64),
        userVersion: 7,
        tables: []
      })
    )
    await expect(verifyLegacyDatabaseHandoverSnapshot({ manifestPath })).rejects.toThrow(
      'LEGACY_DATABASE_BACKUP_INSECURE'
    )
    const repository = new BusinessRepository({
      path: aliasPath,
      handoverManifestPath: manifestPath
    })
    try {
      await expect(repository.migrationStatus()).rejects.toThrow('BUSINESS_HANDOVER_BACKUP_UNSAFE')
    } finally {
      await repository.close()
    }
  })

  it('rejects an unavailable source database without creating a backup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-legacy-handover-missing-'))
    directories.push(directory)
    await expect(
      createLegacyDatabaseHandoverSnapshot({
        sourcePath: join(directory, 'missing.db'),
        backupDirectory: join(directory, 'backups')
      })
    ).rejects.toThrow('LEGACY_DATABASE_UNAVAILABLE')
  })
})
