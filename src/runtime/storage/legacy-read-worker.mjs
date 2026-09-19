import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

const db = new DatabaseSync(workerData.path, { readOnly: true })
db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;')

const cronJobColumns = `id, name, schedule_kind, schedule_at, schedule_every,
  schedule_expr, schedule_tz, prompt, agent_id, model, model_source, working_folder,
  ssh_connection_id, session_id, source_session_title, source_project_id,
  source_project_name, source_provider_id, delivery_mode, delivery_target,
  plugin_id, plugin_chat_id, enabled, delete_after_run, max_iterations,
  deleted_at, last_fired_at, fire_count, created_at, updated_at, workspace_id`

const cronRunColumns = `r.id, r.job_id, r.started_at, r.finished_at, r.status,
  r.tool_call_count, r.output_summary, r.error, r.scheduled_for,
  r.job_name_snapshot, r.prompt_snapshot, r.source_session_id_snapshot,
  r.source_session_title_snapshot, r.source_project_id_snapshot,
  r.source_project_name_snapshot, r.source_provider_id_snapshot,
  r.model_snapshot, r.model_source_snapshot, r.working_folder_snapshot,
  r.delivery_mode_snapshot, r.delivery_target_snapshot`

function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new Error('INVALID_LEGACY_REQUEST')
  return value.trim()
}

function limit(value, fallback = 200, maximum = 2000) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum)
    throw new Error('INVALID_LEGACY_REQUEST')
  return resolved
}

function offset(value) {
  const resolved = value ?? 0
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 1_000_000)
    throw new Error('INVALID_LEGACY_REQUEST')
  return resolved
}

function usageNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const messageReadsRequiringNormalizedOrder = new Set([
  'messages-list',
  'messages-list-user',
  'messages-list-locator',
  'messages-list-page',
  'messages-list-markers',
  'messages-request-context',
  'messages-window-around'
])

function requireNormalizedMessageSort(sessionId, workspaceId) {
  const owner = db
    .prepare('SELECT 1 FROM sessions WHERE id = ? AND workspace_id = ? LIMIT 1')
    .get(sessionId, workspaceId)
  if (!owner) return
  const anomaly = db
    .prepare(
      `SELECT 1 FROM (
         SELECT sort_order,
                ROW_NUMBER() OVER (ORDER BY sort_order ASC, created_at ASC) - 1 AS expected
           FROM messages
          WHERE session_id = ?
       ) WHERE sort_order != expected LIMIT 1`
    )
    .get(sessionId)
  if (anomaly) throw new Error('LEGACY_MESSAGE_SORT_REQUIRES_NATIVE_NORMALIZATION')
}

function usageTimestamp(value) {
  if (!Number.isSafeInteger(value)) throw new Error('INVALID_LEGACY_REQUEST')
  return value
}

function optionalUsageFilter(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > 2048) throw new Error('INVALID_LEGACY_REQUEST')
  return value.trim() ? value : null
}

function usageWhere(args) {
  const workspaceId = identifier(args.workspaceId)
  const from = usageTimestamp(args.from)
  const to = usageTimestamp(args.to)
  const where = ['workspace_id = ?', 'created_at >= ?', 'created_at <= ?']
  const params = [workspaceId, from, to]
  for (const [field, column] of [
    ['providerId', 'provider_id'],
    ['modelId', 'model_id'],
    ['sourceKind', 'source_kind']
  ]) {
    const value = optionalUsageFilter(args[field])
    if (value !== null) {
      where.push(`${column} = ?`)
      params.push(value)
    }
  }
  return { clause: where.join(' AND '), params }
}

function nativeUsageShape(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null))
}

function nativeProjectShape(row) {
  return row ? nativeUsageShape(row) : null
}

function nativePlanShape(row) {
  return row ?? null
}

const nativeMessageShape = nativeProjectShape

function usageRawRows(operation, args) {
  const { clause, params } = usageWhere(args)
  const effective = `COALESCE(billable_input_tokens,
    MAX(input_tokens-COALESCE(cache_read_tokens,0)-COALESCE(cache_creation_tokens,0),0))`
  const summary = `COUNT(*) AS request_count,
    COALESCE(SUM(${effective}),0) AS input_tokens,
    COALESCE(SUM(${effective}),0) AS billable_input_tokens,
    COALESCE(SUM(input_tokens),0) AS total_input_tokens,
    COALESCE(SUM(output_tokens),0) AS output_tokens,
    COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
    COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
    COALESCE(SUM(total_cost_usd),0) AS total_cost_usd`
  let dimensions
  let group
  let order
  if (operation === 'daily') {
    dimensions = "strftime('%Y-%m-%d',created_at/1000,'unixepoch','localtime') AS day"
    group = 'day'
    order = 'day DESC'
  } else if (operation === 'timeline') {
    dimensions =
      args.bucket === 'hour'
        ? "strftime('%Y-%m-%d %H:00',created_at/1000,'unixepoch','localtime') AS bucket_label"
        : "strftime('%Y-%m-%d',created_at/1000,'unixepoch','localtime') AS bucket_label"
    group = 'bucket_label'
    order = 'bucket_label DESC'
  } else if (operation === 'by-model') {
    dimensions = 'model_id,model_name,provider_id,provider_name'
    group = dimensions
    order = 'total_cost_usd DESC,request_count DESC'
  } else if (operation === 'by-provider') {
    dimensions = 'provider_id,provider_name,provider_type,provider_builtin_id,provider_base_url'
    group = dimensions
    order = 'total_cost_usd DESC,request_count DESC'
  } else {
    throw new Error('INVALID_LEGACY_REQUEST')
  }
  const latency =
    operation === 'timeline' ? '' : ',AVG(ttft_ms) AS avg_ttft_ms,AVG(total_ms) AS avg_total_ms'
  return withSchemaBoundary(() =>
    db
      .prepare(
        `SELECT ${dimensions},${summary}${latency} FROM usage_events
         WHERE ${clause} GROUP BY ${group} ORDER BY ${order}`
      )
      .all(...params)
      .map(nativeUsageShape)
  )
}

function usageActivity(operation, args) {
  const workspaceId = identifier(args.workspaceId)
  const from = usageTimestamp(args.from)
  const to = usageTimestamp(args.to)
  const day = db.prepare("SELECT strftime('%Y-%m-%d',?/1000,'unixepoch','localtime') AS day")
  const fromDay = day.get(from)?.day
  const toDay = day.get(to)?.day
  if (!fromDay || !toDay) throw new Error('INVALID_LEGACY_REQUEST')
  const values = [workspaceId, fromDay, toDay]
  const filter = 'workspace_id=? AND day>=? AND day<=?'
  const common = `COALESCE(SUM(request_count),0) AS request_count,
    COALESCE(SUM(input_tokens),0) AS input_tokens,
    COALESCE(SUM(input_tokens),0) AS billable_input_tokens,
    COALESCE(SUM(input_tokens+cache_creation_tokens+cache_read_tokens),0) AS total_input_tokens,
    COALESCE(SUM(output_tokens),0) AS output_tokens,
    COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
    COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
    COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
    COALESCE(SUM(total_cost_usd),0) AS total_cost_usd`
  return withSchemaBoundary(() => {
    if (operation === 'activity-overview')
      return {
        row: nativeUsageShape(
          db.prepare(`SELECT ${common} FROM usage_activity_daily_v2 WHERE ${filter}`).get(...values)
        )
      }
    if (operation === 'activity-daily')
      return {
        rows: db
          .prepare(
            `SELECT day,request_count,input_tokens,
             input_tokens AS billable_input_tokens,
             input_tokens+cache_creation_tokens+cache_read_tokens AS total_input_tokens,
             output_tokens,cache_creation_tokens,cache_read_tokens,reasoning_tokens,total_cost_usd
             FROM usage_activity_daily_v2 WHERE ${filter} ORDER BY day DESC`
          )
          .all(...values)
          .map(nativeUsageShape)
      }
    const requestedLimit = args.limit ?? 50
    const requestedOffset = args.offset ?? 0
    if (!Number.isSafeInteger(requestedLimit) || !Number.isSafeInteger(requestedOffset))
      throw new Error('INVALID_LEGACY_REQUEST')
    const count = Math.min(Math.max(requestedLimit, 1), 200)
    const start = Math.max(requestedOffset, 0)
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
             ${common} FROM usage_activity_daily_models_v2 WHERE ${filter}
             GROUP BY model_id,provider_id ${order}`
          )
          .all(...values, count, start)
          .map(nativeUsageShape)
      }
    if (operation === 'activity-by-provider')
      return {
        rows: db
          .prepare(
            `SELECT NULLIF(provider_id,'') AS provider_id,
             COALESCE(MAX(provider_name),NULLIF(provider_id,''),'-') AS provider_name,
             MAX(provider_type) AS provider_type,MAX(provider_builtin_id) AS provider_builtin_id,
             MAX(provider_base_url) AS provider_base_url,
             ${common} FROM usage_activity_daily_providers_v2 WHERE ${filter}
             GROUP BY provider_id ${order}`
          )
          .all(...values, count, start)
          .map(nativeUsageShape)
      }
    throw new Error('INVALID_LEGACY_REQUEST')
  })
}

function contextLimit(value, fallback, maximum = 5000) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved)) throw new Error('INVALID_LEGACY_REQUEST')
  return Math.min(Math.max(resolved, 1), maximum)
}

function searchQuery(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048)
    throw new Error('INVALID_LEGACY_REQUEST')
  return value.trim()
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => '\\' + character)
}

function rowPage(sessionId, workspaceId, count, start) {
  return db
    .prepare(
      `SELECT m.id, m.session_id, m.role, m.content, m.meta, m.created_at, m.usage, m.sort_order
         FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE m.session_id = ? AND s.workspace_id = ?
        ORDER BY m.sort_order ASC, m.created_at ASC
        LIMIT ? OFFSET ?`
    )
    .all(sessionId, workspaceId, count, start)
    .map(nativeMessageShape)
}

function agentChangeSet(runId, workspaceId) {
  const row = db
    .prepare(
      `SELECT run_id,session_id,assistant_message_id,status,created_at,updated_at
      FROM agent_change_sets WHERE run_id=? AND workspace_id=?`
    )
    .get(runId, workspaceId)
  if (!row) return null
  const changes = db
    .prepare(
      `SELECT id,run_id,session_id,tool_use_id,tool_name,file_path,transport,
      connection_id,op,status,before_json,after_json,created_at,reverted_at
      FROM agent_file_changes WHERE run_id=?
      ORDER BY sort_order ASC,created_at ASC`
    )
    .all(runId)
    .map((change) => ({
      id: change.id,
      runId: change.run_id,
      sessionId: change.session_id ?? undefined,
      toolUseId: change.tool_use_id ?? undefined,
      toolName: change.tool_name ?? undefined,
      filePath: change.file_path,
      transport: change.transport,
      connectionId: change.connection_id ?? undefined,
      op: change.op,
      status: change.status,
      before: JSON.parse(change.before_json),
      after: JSON.parse(change.after_json),
      createdAt: change.created_at,
      revertedAt: change.reverted_at ?? undefined
    }))
  return {
    runId: row.run_id,
    sessionId: row.session_id ?? undefined,
    assistantMessageId: row.assistant_message_id,
    status: row.status,
    changes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function withSchemaBoundary(operation) {
  try {
    return operation()
  } catch (error) {
    if (String(error?.message ?? error).includes('no such table'))
      throw new Error('LEGACY_SCHEMA_UNSUPPORTED')
    throw error
  }
}

function nativeMemoryRoot(row) {
  if (!row) return null
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id,
    workingFolder: row.working_folder,
    sshConnectionId: row.ssh_connection_id,
    rootPath: row.root_path,
    transport: row.transport,
    ownerKey: row.owner_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id
  }
}

function nativeMemoryJob(row) {
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    memoryRootId: row.memory_root_id,
    sourceSessionId: row.source_session_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    attempts: row.attempts,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id
  }
}

function nativeMemoryStage1Output(row) {
  return {
    id: row.id,
    memoryRootId: row.memory_root_id,
    scope: row.scope,
    sourceSessionId: row.source_session_id,
    sourceUpdatedAt: row.source_updated_at,
    rawMemory: row.raw_memory,
    rolloutSummary: row.rollout_summary,
    rolloutSlug: row.rollout_slug,
    fingerprint: row.fingerprint,
    status: row.status,
    usageCount: row.usage_count,
    lastUsageAt: row.last_usage_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function nativeMemoryAutomationEntry(row) {
  if (!row) return null
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    rootScope: row.root_scope,
    memoryRootId: row.memory_root_id,
    jobId: row.job_id,
    projectId: row.project_id,
    target: row.target,
    kind: row.kind,
    content: row.content,
    confidence: row.confidence,
    sourceSessionId: row.source_session_id,
    targetPath: row.target_path,
    status: row.status,
    filterReason: row.filter_reason,
    fingerprint: row.fingerprint,
    evidenceJson: row.evidence_json,
    writtenAt: row.written_at,
    error: row.error,
    beforeContent: row.before_content,
    afterContent: row.after_content,
    appendedText: row.appended_text,
    sshConnectionId: row.ssh_connection_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    undoneAt: row.undone_at
  }
}

function dispatch(method, args = {}) {
  if (messageReadsRequiringNormalizedOrder.has(method)) {
    requireNormalizedMessageSort(identifier(args.sessionId), identifier(args.workspaceId))
  }
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('INVALID_LEGACY_REQUEST')
  if (method === 'qq-wakeup-resolve') {
    const workspaceId = identifier(args.workspaceId)
    const pluginId = identifier(args.pluginId)
    const openId = identifier(args.openId)
    const now = usageTimestamp(args.now)
    if (now < 0) throw new Error('INVALID_LEGACY_REQUEST')
    return withSchemaBoundary(() => {
      const source = db
        .prepare(
          `SELECT source_message_id,source_timestamp FROM qq_wakeup_windows_v2
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
                `SELECT 1 FROM qq_wakeup_windows_v2
                 WHERE workspace_id=? AND plugin_id=? AND open_id=? AND period_key=?`
              )
              .get(workspaceId, pluginId, openId, periodKey)
      return {
        enabled: periodKey !== null && !sent,
        periodKey,
        sourceMessageId: source?.source_message_id ?? null,
        sourceTimestamp
      }
    })
  }
  if (method === 'wiki-get') {
    const { projectRoot, workspaceId } = args
    if (
      typeof projectRoot !== 'string' ||
      !projectRoot ||
      projectRoot.length > 8192 ||
      projectRoot.includes('\0') ||
      !isAbsolute(projectRoot) ||
      resolve(projectRoot) !== projectRoot
    )
      throw new Error('INVALID_LEGACY_WIKI_PROJECT_ROOT')
    const workspace = identifier(workspaceId)
    const storageKey =
      workspace === 'local-personal'
        ? projectRoot
        : `workspace-wiki:${createHash('sha256')
            .update(JSON.stringify([workspace, projectRoot]))
            .digest('hex')}`
    return withSchemaBoundary(() => {
      const row = db
        .prepare('SELECT document_json FROM wiki_documents WHERE project_root=?')
        .get(storageKey)
      if (!row) return null
      const document = JSON.parse(row.document_json)
      if (!document || document.projectRoot !== projectRoot)
        throw new Error('LEGACY_WIKI_DOCUMENT_INVALID')
      return document
    })
  }
  if (method === 'desktop-flows-list') {
    const workspaceId = identifier(args.workspaceId)
    return withSchemaBoundary(() =>
      db
        .prepare(
          'SELECT flow_json FROM desktop_flows WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 100'
        )
        .all(workspaceId)
        .map((row) => row.flow_json)
    )
  }
  if (method === 'desktop-flow-runs-list') {
    const workspaceId = identifier(args.workspaceId)
    const runLimit = limit(args.limit, 100, 10000)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT json_object('id',r.id,'flowId',r.flow_id,'state',r.state,
            'errorMessage',r.error_message,'startedAt',r.started_at,
            'finishedAt',r.finished_at) AS value
           FROM desktop_flow_runs r JOIN desktop_flows f ON f.id=r.flow_id
           WHERE f.workspace_id=? ORDER BY r.started_at DESC LIMIT ?`
        )
        .all(workspaceId, runLimit)
        .map((row) => row.value)
    )
  }
  if (method === 'draw-runs-list') {
    const workspaceId = identifier(args.workspaceId)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT id,workspace_id,prompt,provider_name,model_name,mode,meta_json,
                  created_at,is_generating,images_json,error_json,updated_at
             FROM draw_runs WHERE workspace_id=? ORDER BY created_at DESC`
        )
        .all(workspaceId)
    )
  }
  if (method === 'sub-agent-history-index' || method === 'sub-agent-history-list') {
    const sessionId = identifier(args.sessionId)
    const workspaceId = identifier(args.workspaceId)
    const rowLimit = limit(
      args.limit,
      method === 'sub-agent-history-index' ? 100 : 50,
      method === 'sub-agent-history-index' ? 500 : 200
    )
    const rowOffset = method === 'sub-agent-history-list' ? offset(args.offset) : 0
    return withSchemaBoundary(() => {
      const owner = db
        .prepare('SELECT workspace_id FROM sessions WHERE id=? LIMIT 1')
        .get(sessionId)
      if (!owner || owner.workspace_id !== workspaceId)
        throw new Error('SUB_AGENT_HISTORY_SESSION_WORKSPACE_MISMATCH')
      const includeSnapshot = method === 'sub-agent-history-list'
      const columns = `id,session_id AS sessionId,sub_agent_id AS subAgentId,
        tool_use_id AS toolUseId,name,status,started_at AS startedAt,
        completed_at AS completedAt,updated_at AS updatedAt,sort_order AS sortOrder
        ${includeSnapshot ? ',snapshot_json AS snapshotJson' : ''}`
      const rows = db
        .prepare(
          `SELECT ${columns} FROM sub_agent_history WHERE session_id=?
         ORDER BY started_at DESC,sort_order DESC LIMIT ? OFFSET ?`
        )
        .all(sessionId, rowLimit + (includeSnapshot ? 1 : 0), rowOffset)
      if (!includeSnapshot) return rows
      const hasMore = rows.length > rowLimit
      return {
        items: hasMore ? rows.slice(0, rowLimit) : rows,
        offset: rowOffset,
        limit: rowLimit,
        hasMore
      }
    })
  }
  if (method === 'runtime-tool-results-lookup') {
    const sessionId = identifier(args.sessionId)
    const workspaceId = identifier(args.workspaceId)
    if (!Array.isArray(args.toolUseIds)) throw new Error('INVALID_LEGACY_REQUEST')
    const ids = []
    const seen = new Set()
    for (const value of args.toolUseIds) {
      if (typeof value !== 'string') continue
      const id = value.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
      if (ids.length === 256) break
    }
    if (ids.length === 0) return []
    return withSchemaBoundary(() => {
      const owner = db
        .prepare('SELECT workspace_id FROM sessions WHERE id=? LIMIT 1')
        .get(sessionId)
      if (!owner || owner.workspace_id !== workspaceId)
        throw new Error('TOOL_RESULT_SESSION_WORKSPACE_MISMATCH')
      const rows = db
        .prepare(
          `SELECT session_id AS sessionId,tool_use_id AS toolUseId,
                run_id AS runId,tool_name AS toolName,status,content_json AS contentJson,
                is_error AS isError,started_at AS startedAt,completed_at AS completedAt
           FROM runtime_tool_results WHERE session_id=?
             AND tool_use_id IN (${ids.map(() => '?').join(',')})
           ORDER BY completed_at ASC`
        )
        .all(sessionId, ...ids)
      return rows.map(({ contentJson, isError, startedAt, ...row }) => ({
        ...row,
        content: JSON.parse(contentJson),
        isError: isError !== 0,
        ...(startedAt === null ? {} : { startedAt })
      }))
    })
  }
  if (method === 'memory-roots-list') {
    const workspaceId = identifier(args.workspaceId)
    return withSchemaBoundary(() => {
      const filters = ['workspace_id=?']
      const values = [workspaceId]
      if (args.scope != null && args.scope !== '' && args.scope !== 'both') {
        filters.push('scope=?')
        values.push(identifier(args.scope))
      }
      for (const [field, column] of [
        ['projectId', 'project_id'],
        ['workingFolder', 'working_folder'],
        ['sshConnectionId', 'ssh_connection_id'],
        ['rootPath', 'root_path']
      ]) {
        if (args[field] === undefined) continue
        const value = args[field]
        if (value !== null && typeof value !== 'string') throw new Error('INVALID_LEGACY_REQUEST')
        filters.push(`${column} IS ?`)
        values.push(value)
      }
      return db
        .prepare(
          `SELECT id,scope,project_id,working_folder,ssh_connection_id,root_path,
                  transport,owner_key,created_at,updated_at,workspace_id
             FROM memory_roots WHERE ${filters.join(' AND ')}
             ORDER BY scope ASC,updated_at DESC`
        )
        .all(...values)
        .map(nativeMemoryRoot)
    })
  }
  if (method === 'memory-root-get') {
    const workspaceId = identifier(args.workspaceId)
    const id = identifier(args.id)
    return withSchemaBoundary(() =>
      nativeMemoryRoot(
        db
          .prepare(
            `SELECT id,scope,project_id,working_folder,ssh_connection_id,root_path,
                    transport,owner_key,created_at,updated_at,workspace_id
               FROM memory_roots WHERE id=? AND workspace_id=? LIMIT 1`
          )
          .get(id, workspaceId)
      )
    )
  }
  if (method === 'memory-jobs-list') {
    const workspaceId = identifier(args.workspaceId)
    return withSchemaBoundary(() => {
      const filters = ['workspace_id=?']
      const values = [workspaceId]
      for (const [field, column] of [
        ['memoryRootId', 'memory_root_id'],
        ['sourceSessionId', 'source_session_id']
      ]) {
        if (args[field] === undefined) continue
        const value = args[field]
        if (value !== null && typeof value !== 'string') throw new Error('INVALID_LEGACY_REQUEST')
        filters.push(`${column} IS ?`)
        values.push(value)
      }
      for (const [field, column] of [
        ['statuses', 'status'],
        ['kinds', 'kind']
      ]) {
        const items = args[field]
        if (items == null) continue
        if (!Array.isArray(items) || items.some((item) => typeof item !== 'string'))
          throw new Error('INVALID_LEGACY_REQUEST')
        if (!items.length) continue
        filters.push(`${column} IN (${items.map(() => '?').join(',')})`)
        values.push(...items)
      }
      const requestedLimit = args.limit ?? 50
      if (!Number.isSafeInteger(requestedLimit)) throw new Error('INVALID_LEGACY_REQUEST')
      const jobLimit = Math.max(1, Math.min(500, requestedLimit))
      return db
        .prepare(
          `SELECT id,kind,status,memory_root_id,source_session_id,lease_owner,
                  lease_expires_at,attempts,error,started_at,finished_at,
                  created_at,updated_at,workspace_id
             FROM memory_jobs WHERE ${filters.join(' AND ')}
             ORDER BY updated_at DESC LIMIT ?`
        )
        .all(...values, jobLimit)
        .map(nativeMemoryJob)
    })
  }
  if (method === 'memory-job-get') {
    const workspaceId = identifier(args.workspaceId)
    const id = identifier(args.id)
    return withSchemaBoundary(() =>
      nativeMemoryJob(
        db
          .prepare(
            `SELECT id,kind,status,memory_root_id,source_session_id,lease_owner,
                    lease_expires_at,attempts,error,started_at,finished_at,
                    created_at,updated_at,workspace_id
               FROM memory_jobs WHERE id=? AND workspace_id=? LIMIT 1`
          )
          .get(id, workspaceId)
      )
    )
  }
  if (method === 'memory-stage1-list') {
    const workspaceId = identifier(args.workspaceId)
    const memoryRootId = identifier(args.memoryRootId)
    const requestedLimit = args.limit ?? 500
    if (!Number.isSafeInteger(requestedLimit)) throw new Error('INVALID_LEGACY_REQUEST')
    const stage1Limit = Math.max(1, Math.min(5000, requestedLimit))
    return withSchemaBoundary(() => {
      const root = db
        .prepare('SELECT 1 FROM memory_roots WHERE id=? AND workspace_id=?')
        .get(memoryRootId, workspaceId)
      if (!root) throw new Error('LEGACY_MEMORY_ROOT_NOT_FOUND')
      return db
        .prepare(
          `SELECT id,memory_root_id,scope,source_session_id,source_updated_at,
                  raw_memory,rollout_summary,rollout_slug,fingerprint,status,
                  usage_count,last_usage_at,created_at,updated_at
             FROM memory_stage1_outputs
             WHERE memory_root_id=? AND status='active'
             ORDER BY created_at DESC LIMIT ?`
        )
        .all(memoryRootId, stage1Limit)
        .map(nativeMemoryStage1Output)
    })
  }
  if (method === 'memory-automation-list') {
    const workspaceId = identifier(args.workspaceId)
    return withSchemaBoundary(() => {
      const filters = ['workspace_id=?']
      const values = [workspaceId]
      for (const [field, column] of [
        ['statuses', 'status'],
        ['targets', 'target']
      ]) {
        const items = args[field]
        if (items == null) continue
        if (!Array.isArray(items) || items.some((item) => typeof item !== 'string'))
          throw new Error('INVALID_LEGACY_REQUEST')
        if (!items.length) continue
        filters.push(`${column} IN (${items.map(() => '?').join(',')})`)
        values.push(...items)
      }
      for (const [field, column] of [
        ['id', 'id'],
        ['memoryRootId', 'memory_root_id'],
        ['rootScope', 'root_scope'],
        ['projectId', 'project_id'],
        ['sourceSessionId', 'source_session_id']
      ]) {
        if (!(field in args)) continue
        const value = args[field]
        if (value !== null && typeof value !== 'string') throw new Error('INVALID_LEGACY_REQUEST')
        filters.push(`${column} IS ?`)
        values.push(value)
      }
      for (const [field, column] of [
        ['targetPath', 'target_path'],
        ['fingerprint', 'fingerprint']
      ]) {
        const value = args[field]
        if (value == null || value === '') continue
        if (typeof value !== 'string') throw new Error('INVALID_LEGACY_REQUEST')
        filters.push(`${column}=?`)
        values.push(value)
      }
      if (args.targetPathIncludes != null && args.targetPathIncludes !== '') {
        if (typeof args.targetPathIncludes !== 'string') throw new Error('INVALID_LEGACY_REQUEST')
        filters.push('target_path LIKE ?')
        values.push(`%${args.targetPathIncludes}%`)
      }
      const requestedLimit = args.limit ?? 50
      const requestedOffset = args.offset ?? 0
      if (!Number.isSafeInteger(requestedLimit) || !Number.isSafeInteger(requestedOffset))
        throw new Error('INVALID_LEGACY_REQUEST')
      const entryLimit = Math.max(1, Math.min(500, requestedLimit))
      const entryOffset = Math.max(0, requestedOffset)
      const snapshotColumns = args.includeContentSnapshots
        ? 'before_content,after_content,appended_text'
        : 'NULL AS before_content,NULL AS after_content,NULL AS appended_text'
      return db
        .prepare(
          `SELECT id,scope,root_scope,memory_root_id,job_id,project_id,target,kind,
                  content,confidence,source_session_id,target_path,status,filter_reason,
                  fingerprint,evidence_json,written_at,error,${snapshotColumns},
                  ssh_connection_id,created_at,updated_at,undone_at,workspace_id
             FROM memory_automation_entries WHERE ${filters.join(' AND ')}
             ORDER BY created_at DESC LIMIT ? OFFSET ?`
        )
        .all(...values, entryLimit, entryOffset)
        .map(nativeMemoryAutomationEntry)
    })
  }
  if (method === 'memory-automation-get') {
    const workspaceId = identifier(args.workspaceId)
    const id = identifier(args.id)
    return withSchemaBoundary(() =>
      nativeMemoryAutomationEntry(
        db
          .prepare(
            `SELECT id,scope,root_scope,memory_root_id,job_id,project_id,target,kind,
                    content,confidence,source_session_id,target_path,status,filter_reason,
                    fingerprint,evidence_json,written_at,error,before_content,after_content,
                    appended_text,ssh_connection_id,created_at,updated_at,undone_at,workspace_id
               FROM memory_automation_entries WHERE id=? AND workspace_id=? LIMIT 1`
          )
          .get(id, workspaceId)
      )
    )
  }
  if (method === 'cron-jobs-list') {
    const workspaceId = identifier(args.workspaceId)
    const sessionId =
      args.sessionId == null || args.sessionId === '' ? null : identifier(args.sessionId)
    const includeDeleted = args.includeDeleted === true
    return withSchemaBoundary(() => {
      const filters = ['workspace_id = ?']
      const values = [workspaceId]
      if (sessionId !== null) {
        filters.push('session_id = ?')
        values.push(sessionId)
      }
      if (!includeDeleted) filters.push('deleted_at IS NULL')
      return db
        .prepare(
          `SELECT ${cronJobColumns} FROM cron_jobs WHERE ${filters.join(' AND ')} ORDER BY created_at DESC`
        )
        .all(...values)
    })
  }
  if (method === 'cron-job-get') {
    const workspaceId = identifier(args.workspaceId)
    const jobId = identifier(args.jobId)
    return withSchemaBoundary(
      () =>
        db
          .prepare(
            `SELECT ${cronJobColumns} FROM cron_jobs WHERE id = ? AND workspace_id = ? LIMIT 1`
          )
          .get(jobId, workspaceId) ?? null
    )
  }
  if (method === 'cron-runs-list') {
    const workspaceId = identifier(args.workspaceId)
    const jobId = args.jobId == null || args.jobId === '' ? null : identifier(args.jobId)
    const sessionId =
      args.sessionId == null || args.sessionId === '' ? null : identifier(args.sessionId)
    const runLimit = Math.max(1, Math.min(limit(args.limit, 200, 1000), 1000))
    const start = args.start == null ? null : usageTimestamp(args.start)
    const end = args.end == null ? null : usageTimestamp(args.end)
    return withSchemaBoundary(() => {
      const filters = ['j.workspace_id = ?']
      const values = [workspaceId]
      if (jobId !== null) {
        filters.push('r.job_id = ?')
        values.push(jobId)
      }
      if (sessionId !== null) {
        filters.push('COALESCE(r.source_session_id_snapshot, j.session_id) = ?')
        values.push(sessionId)
      }
      if (start !== null) {
        filters.push('r.started_at >= ?')
        values.push(start)
      }
      if (end !== null) {
        filters.push('r.started_at <= ?')
        values.push(end)
      }
      return db
        .prepare(
          `SELECT ${cronRunColumns} FROM cron_runs r JOIN cron_jobs j ON j.id = r.job_id
           WHERE ${filters.join(' AND ')} ORDER BY r.started_at DESC LIMIT ?`
        )
        .all(...values, runLimit)
    })
  }
  if (method === 'cron-run-get') {
    const workspaceId = identifier(args.workspaceId)
    const runId = identifier(args.runId)
    return withSchemaBoundary(
      () =>
        db
          .prepare(
            `SELECT ${cronRunColumns} FROM cron_runs r
             WHERE r.id = ? AND EXISTS (
               SELECT 1 FROM cron_jobs j WHERE j.id = r.job_id AND j.workspace_id = ?
             ) LIMIT 1`
          )
          .get(runId, workspaceId) ?? null
    )
  }
  if (method === 'cron-run-detail') {
    const workspaceId = identifier(args.workspaceId)
    const runId = identifier(args.runId)
    return withSchemaBoundary(() => {
      const run = db
        .prepare(
          `SELECT ${cronRunColumns} FROM cron_runs r
           WHERE r.id = ? AND EXISTS (
             SELECT 1 FROM cron_jobs j WHERE j.id = r.job_id AND j.workspace_id = ?
           ) LIMIT 1`
        )
        .get(runId, workspaceId)
      if (!run) return null
      const job =
        db
          .prepare(
            `SELECT ${cronJobColumns} FROM cron_jobs WHERE id = ? AND workspace_id = ? LIMIT 1`
          )
          .get(run.job_id, workspaceId) ?? null
      const messages = db
        .prepare(
          `SELECT id, role, content, usage, message_source, created_at
           FROM cron_run_messages WHERE run_id = ? ORDER BY sort_order ASC`
        )
        .all(runId)
      const logs = db
        .prepare(
          `SELECT id, timestamp, type, content FROM cron_run_logs
           WHERE run_id = ? ORDER BY sort_order ASC`
        )
        .all(runId)
      return { run, job, messages, logs }
    })
  }
  if (method === 'usage-overview') {
    const { clause, params } = usageWhere(args)
    return withSchemaBoundary(() =>
      nativeUsageShape(
        db
          .prepare(
            `SELECT COUNT(*) AS request_count,
          COALESCE(SUM(COALESCE(billable_input_tokens,
            MAX(input_tokens-COALESCE(cache_read_tokens,0)-COALESCE(cache_creation_tokens,0),0))),0)
            AS input_tokens,
          COALESCE(SUM(COALESCE(billable_input_tokens,
            MAX(input_tokens-COALESCE(cache_read_tokens,0)-COALESCE(cache_creation_tokens,0),0))),0)
            AS billable_input_tokens,
          COALESCE(SUM(input_tokens),0) AS total_input_tokens,
          COALESCE(SUM(output_tokens),0) AS output_tokens,
          COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
          COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
          COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
          COALESCE(SUM(total_cost_usd),0) AS total_cost_usd,
          AVG(ttft_ms) AS avg_ttft_ms,AVG(total_ms) AS avg_total_ms
          FROM usage_events WHERE ${clause}`
          )
          .get(...params)
      )
    )
  }
  if (method === 'usage-raw-rows') return usageRawRows(args.operation, args)
  if (method === 'usage-activity') return usageActivity(args.operation, args)
  if (method === 'usage-events-list') {
    const { clause, params } = usageWhere(args)
    const count = Math.min(Math.max(args.limit ?? 50, 1), 200)
    const start = Math.max(args.offset ?? 0, 0)
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(start))
      throw new Error('INVALID_LEGACY_REQUEST')
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT id,created_at,request_started_at,request_finished_at,session_id,message_id,
          project_id,source_kind,provider_id,provider_name,provider_type,provider_builtin_id,
          provider_base_url,model_id,model_name,model_category,request_type,input_tokens,
          billable_input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
          reasoning_tokens,context_tokens,input_price,output_price,cache_creation_price,
          cache_hit_price,input_cost_usd,output_cost_usd,cache_creation_cost_usd,
          cache_hit_cost_usd,total_cost_usd,ttft_ms,total_ms,tps,provider_response_id,
          LENGTH(COALESCE(request_debug_json,'')) AS request_debug_chars,
          LENGTH(COALESCE(usage_raw_json,'')) AS usage_raw_chars,
          LENGTH(COALESCE(meta_json,'')) AS meta_chars
          FROM usage_events WHERE ${clause}
          ORDER BY created_at DESC LIMIT ? OFFSET ?`
        )
        .all(...params, count, start)
        .map(nativeUsageShape)
    )
  }
  if (method === 'agent-change-get') {
    return withSchemaBoundary(() =>
      agentChangeSet(identifier(args.runId), identifier(args.workspaceId))
    )
  }
  if (method === 'agent-changes-list-session') {
    const sessionId = identifier(args.sessionId)
    const workspaceId = identifier(args.workspaceId)
    return withSchemaBoundary(() => {
      const owner = db.prepare('SELECT workspace_id FROM sessions WHERE id=?').get(sessionId)
      if (!owner || owner.workspace_id !== workspaceId)
        throw new Error('LEGACY_AGENT_CHANGE_WORKSPACE_MISMATCH')
      return db
        .prepare(
          `SELECT DISTINCT s.run_id FROM agent_change_sets s
          LEFT JOIN agent_file_changes c ON c.run_id=s.run_id
          WHERE s.workspace_id=? AND (s.session_id=? OR c.session_id=?)
          ORDER BY s.created_at ASC,s.run_id ASC`
        )
        .all(workspaceId, sessionId, sessionId)
        .map(({ run_id }) => agentChangeSet(run_id, workspaceId))
    })
  }
  if (method === 'sessions-list') {
    const workspaceId = identifier(args.workspaceId)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT id, COALESCE(title, '') AS title, icon, COALESCE(mode, 'chat') AS mode,
                  created_at, updated_at, project_id, working_folder, ssh_connection_id, plan_id,
                  COALESCE(pinned, 0) AS pinned, plugin_id, external_chat_id, provider_id, model_id,
                  model_selection_mode, model_source, task_profile,
                  COALESCE(task_profile_locked, 0) AS task_profile_locked,
                  workspace_id, COALESCE(message_count, 0) AS message_count
             FROM sessions
            WHERE workspace_id = ?
            ORDER BY updated_at DESC
            LIMIT ? OFFSET ?`
        )
        .all(workspaceId, limit(args.limit), offset(args.offset))
    )
  }
  if (method === 'session-get') {
    const workspaceId = identifier(args.workspaceId)
    const id = identifier(args.id)
    return withSchemaBoundary(
      () =>
        db
          .prepare(
            `SELECT id, COALESCE(title, '') AS title, icon, COALESCE(mode, 'chat') AS mode,
                  created_at, updated_at, project_id, working_folder, ssh_connection_id, plan_id,
                  COALESCE(pinned, 0) AS pinned, plugin_id, external_chat_id, provider_id, model_id,
                  model_selection_mode, model_source, task_profile,
                  COALESCE(task_profile_locked, 0) AS task_profile_locked,
                  workspace_id, COALESCE(message_count, 0) AS message_count
             FROM sessions WHERE id = ? AND workspace_id = ?`
          )
          .get(id, workspaceId) ?? null
    )
  }
  if (method === 'channel-session-status') {
    const sessionId = identifier(args.sessionId)
    const workspaceId = identifier(args.workspaceId)
    return withSchemaBoundary(() => {
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
    })
  }
  if (method === 'channel-session-usage-stats') {
    const sessionId = identifier(args.sessionId)
    const workspaceId = identifier(args.workspaceId)
    return withSchemaBoundary(() => {
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
          result.requestCount += Array.isArray(usage.requestTimings)
            ? usage.requestTimings.length
            : 1
          result.assistantReplies++
          if (result.assistantReplies === 1) result.firstCreatedAt = row.created_at
          result.lastCreatedAt = row.created_at
        } catch {
          // Historical malformed usage rows do not contribute to Native statistics.
        }
      }
      result.hasUsage = result.assistantReplies > 0
      return result
    })
  }
  if (method === 'plugin-sessions-list') {
    const workspaceId = identifier(args.workspaceId)
    const pluginId = identifier(args.pluginId)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT id, title, icon, mode, created_at, updated_at, project_id, working_folder,
                  ssh_connection_id, plan_id, pinned, plugin_id, external_chat_id, provider_id,
                  model_id, model_selection_mode, model_source, workspace_id,
                  COALESCE(message_count, 0) AS message_count
             FROM sessions
            WHERE plugin_id = ? AND workspace_id = ?
            ORDER BY updated_at DESC`
        )
        .all(pluginId, workspaceId)
    )
  }
  if (method === 'plugin-sessions-list-all') {
    const workspaceId = identifier(args.workspaceId)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT id,title,icon,mode,created_at,updated_at,project_id,working_folder,
                  ssh_connection_id,plan_id,pinned,plugin_id,external_chat_id,provider_id,
                  model_id,model_selection_mode,model_source,workspace_id,
                  COALESCE(message_count,0) AS message_count FROM sessions
             WHERE plugin_id IS NOT NULL AND plugin_id!='' AND workspace_id=?
             ORDER BY updated_at DESC`
        )
        .all(workspaceId)
    )
  }
  if (method === 'plugin-session-find-chat') {
    const workspaceId = identifier(args.workspaceId)
    const externalChatId = identifier(args.externalChatId)
    return withSchemaBoundary(
      () =>
        db
          .prepare(
            `SELECT id,title,icon,mode,created_at,updated_at,project_id,working_folder,
                    ssh_connection_id,plan_id,pinned,plugin_id,external_chat_id,provider_id,
                    model_id,model_selection_mode,model_source,workspace_id,
                    COALESCE(message_count,0) AS message_count FROM sessions
               WHERE external_chat_id=? AND workspace_id=?
                 AND plugin_id IS NOT NULL AND plugin_id!='' LIMIT 1`
          )
          .get(externalChatId, workspaceId) ?? null
    )
  }
  if (method === 'plugin-session-messages') {
    const workspaceId = identifier(args.workspaceId)
    const sessionId = identifier(args.sessionId)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT m.id,m.role,m.content,m.created_at FROM messages m
             JOIN sessions s ON s.id=m.session_id
            WHERE m.session_id=? AND s.workspace_id=?
              AND s.plugin_id IS NOT NULL AND s.plugin_id!=''
            ORDER BY m.sort_order ASC LIMIT ? OFFSET ?`
        )
        .all(sessionId, workspaceId, contextLimit(args.limit, 50, 500), offset(args.offset))
    )
  }
  if (method === 'projects-list') {
    const workspaceId = identifier(args.workspaceId)
    if (args.all === true) {
      return withSchemaBoundary(() =>
        db
          .prepare(
            `SELECT id, name, working_folder, ssh_connection_id, plugin_id, pinned,
                    created_at, updated_at, workspace_id, model_source
               FROM projects
              WHERE workspace_id = ?
              ORDER BY pinned DESC, CASE WHEN plugin_id IS NULL THEN 0 ELSE 1 END, updated_at DESC`
          )
          .all(workspaceId)
          .map(nativeProjectShape)
      )
    }
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT id, name, working_folder, ssh_connection_id, plugin_id, pinned,
                  created_at, updated_at, workspace_id, model_source
             FROM projects
            WHERE workspace_id = ?
            ORDER BY pinned DESC, CASE WHEN plugin_id IS NULL THEN 0 ELSE 1 END, updated_at DESC
            LIMIT ? OFFSET ?`
        )
        .all(workspaceId, limit(args.limit), offset(args.offset))
        .map(nativeProjectShape)
    )
  }
  if (method === 'project-get') {
    const workspaceId = identifier(args.workspaceId)
    const id = identifier(args.id)
    return withSchemaBoundary(() =>
      nativeProjectShape(
        db
          .prepare(
            `SELECT id, name, working_folder, ssh_connection_id, plugin_id, pinned,
                    created_at, updated_at, workspace_id, model_source
               FROM projects WHERE id = ? AND workspace_id = ?`
          )
          .get(id, workspaceId)
      )
    )
  }
  if (method === 'project-find-plugin') {
    const workspaceId = identifier(args.workspaceId)
    const pluginId = identifier(args.pluginId)
    return withSchemaBoundary(() =>
      nativeProjectShape(
        db
          .prepare(
            `SELECT id, name, working_folder, ssh_connection_id, plugin_id, pinned,
                    created_at, updated_at, workspace_id, model_source
               FROM projects
              WHERE plugin_id = ? AND workspace_id = ?
              ORDER BY pinned DESC, updated_at DESC LIMIT 1`
          )
          .get(pluginId, workspaceId)
      )
    )
  }
  if (method === 'tasks-list') {
    const workspaceId = identifier(args.workspaceId)
    if (args.all === true) {
      return withSchemaBoundary(() =>
        db
          .prepare(
            `SELECT t.id, t.session_id, t.plan_id, t.subject, t.description, t.active_form,
                    t.status, t.owner, t.blocks, t.blocked_by, t.metadata, t.sort_order,
                    t.created_at, t.updated_at
               FROM tasks t
               JOIN sessions s ON s.id = t.session_id
              WHERE s.workspace_id = ?
              ORDER BY t.updated_at DESC, t.sort_order ASC`
          )
          .all(workspaceId)
      )
    }
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT t.id, t.session_id, t.plan_id, t.subject, t.description, t.active_form,
                  t.status, t.owner, t.blocks, t.blocked_by, t.metadata, t.sort_order,
                  t.created_at, t.updated_at
             FROM tasks t
             JOIN sessions s ON s.id = t.session_id
            WHERE s.workspace_id = ?
            ORDER BY t.updated_at DESC, t.sort_order ASC
            LIMIT ? OFFSET ?`
        )
        .all(workspaceId, limit(args.limit), offset(args.offset))
    )
  }
  if (method === 'tasks-list-session') {
    const workspaceId = identifier(args.workspaceId)
    const sessionId = identifier(args.sessionId)
    if (args.all === true) {
      return withSchemaBoundary(() =>
        db
          .prepare(
            `SELECT t.id, t.session_id, t.plan_id, t.subject, t.description, t.active_form,
                    t.status, t.owner, t.blocks, t.blocked_by, t.metadata, t.sort_order,
                    t.created_at, t.updated_at
               FROM tasks t
               JOIN sessions s ON s.id = t.session_id
              WHERE t.session_id = ? AND s.workspace_id = ?
              ORDER BY t.sort_order ASC`
          )
          .all(sessionId, workspaceId)
      )
    }
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT t.id, t.session_id, t.plan_id, t.subject, t.description, t.active_form,
                  t.status, t.owner, t.blocks, t.blocked_by, t.metadata, t.sort_order,
                  t.created_at, t.updated_at
             FROM tasks t
             JOIN sessions s ON s.id = t.session_id
            WHERE t.session_id = ? AND s.workspace_id = ?
            ORDER BY t.sort_order ASC
            LIMIT ? OFFSET ?`
        )
        .all(sessionId, workspaceId, limit(args.limit), offset(args.offset))
    )
  }
  if (method === 'task-get') {
    const workspaceId = identifier(args.workspaceId)
    const id = identifier(args.id)
    return withSchemaBoundary(
      () =>
        db
          .prepare(
            `SELECT t.id, t.session_id, t.plan_id, t.subject, t.description, t.active_form,
                    t.status, t.owner, t.blocks, t.blocked_by, t.metadata, t.sort_order,
                    t.created_at, t.updated_at
               FROM tasks t
               JOIN sessions s ON s.id = t.session_id
              WHERE t.id = ? AND s.workspace_id = ?`
          )
          .get(id, workspaceId) ?? null
    )
  }
  if (method === 'plans-list') {
    const workspaceId = identifier(args.workspaceId)
    if (args.all === true) {
      return withSchemaBoundary(() =>
        db
          .prepare(
            `SELECT p.id, p.session_id, p.title, p.status, p.file_path, p.content, p.spec_json,
                    p.created_at, p.updated_at, s.workspace_id
               FROM plans p JOIN sessions s ON s.id = p.session_id
              WHERE s.workspace_id = ?
              ORDER BY p.updated_at DESC`
          )
          .all(workspaceId)
          .map(nativePlanShape)
      )
    }
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT p.id, p.session_id, p.title, p.status, p.file_path, p.content, p.spec_json,
                  p.created_at, p.updated_at, s.workspace_id
             FROM plans p JOIN sessions s ON s.id = p.session_id
            WHERE s.workspace_id = ?
            ORDER BY p.updated_at DESC
            LIMIT ? OFFSET ?`
        )
        .all(workspaceId, limit(args.limit), offset(args.offset))
        .map(nativePlanShape)
    )
  }
  if (method === 'goals-list') {
    const workspaceId = identifier(args.workspaceId)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT g.session_id, g.goal_id, g.objective, g.status, g.token_budget,
                  g.tokens_used, g.time_used_seconds, g.created_at, g.updated_at
             FROM session_goals g JOIN sessions s ON s.id = g.session_id
            WHERE s.workspace_id = ? ORDER BY g.updated_at DESC`
        )
        .all(workspaceId)
    )
  }
  if (method === 'goal-get') {
    const sessionId = identifier(args.sessionId)
    const workspaceId = identifier(args.workspaceId)
    return withSchemaBoundary(
      () =>
        db
          .prepare(
            `SELECT g.session_id, g.goal_id, g.objective, g.status, g.token_budget,
                    g.tokens_used, g.time_used_seconds, g.created_at, g.updated_at
               FROM session_goals g JOIN sessions s ON s.id = g.session_id
              WHERE g.session_id = ? AND s.workspace_id = ?`
          )
          .get(sessionId, workspaceId) ?? null
    )
  }
  if (method === 'goal-events-list') {
    const sessionId = identifier(args.sessionId)
    const workspaceId = identifier(args.workspaceId)
    const goalId = args.goalId == null || args.goalId === '' ? null : identifier(args.goalId)
    const count = limit(args.limit, 40, 100)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT e.id, e.session_id, e.goal_id, e.event_type, e.message,
                  e.metadata_json, e.created_at
             FROM session_goal_events e JOIN sessions s ON s.id = e.session_id
            WHERE e.session_id = ? AND s.workspace_id = ?
              AND (? IS NULL OR e.goal_id = ?)
            ORDER BY e.created_at DESC LIMIT ?`
        )
        .all(sessionId, workspaceId, goalId, goalId, count)
    )
  }
  if (method === 'plan-get') {
    const workspaceId = identifier(args.workspaceId)
    const id = identifier(args.id)
    return withSchemaBoundary(() =>
      nativePlanShape(
        db
          .prepare(
            `SELECT p.id, p.session_id, p.title, p.status, p.file_path, p.content, p.spec_json,
                    p.created_at, p.updated_at, s.workspace_id
               FROM plans p JOIN sessions s ON s.id = p.session_id
              WHERE p.id = ? AND s.workspace_id = ?`
          )
          .get(id, workspaceId)
      )
    )
  }
  if (method === 'plan-get-session') {
    const workspaceId = identifier(args.workspaceId)
    const sessionId = identifier(args.sessionId)
    return withSchemaBoundary(() =>
      nativePlanShape(
        db
          .prepare(
            `SELECT p.id, p.session_id, p.title, p.status, p.file_path, p.content, p.spec_json,
                    p.created_at, p.updated_at, s.workspace_id
               FROM plans p JOIN sessions s ON s.id = p.session_id
              WHERE p.session_id = ? AND s.workspace_id = ?
              ORDER BY p.updated_at DESC LIMIT 1`
          )
          .get(sessionId, workspaceId)
      )
    )
  }
  if (method === 'messages-list') {
    const workspaceId = identifier(args.workspaceId)
    const sessionId = identifier(args.sessionId)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT m.id, m.session_id, m.role, m.content, m.meta, m.created_at, m.usage, m.sort_order
             FROM messages m JOIN sessions s ON s.id = m.session_id
            WHERE m.session_id = ? AND s.workspace_id = ?
            ORDER BY m.sort_order ASC, m.created_at ASC`
        )
        .all(sessionId, workspaceId)
        .map(nativeMessageShape)
    )
  }
  if (method === 'messages-list-user') {
    const workspaceId = identifier(args.workspaceId)
    const sessionId = identifier(args.sessionId)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT m.id, m.session_id, m.role, m.content, m.meta, m.created_at, m.usage, m.sort_order
             FROM messages m JOIN sessions s ON s.id = m.session_id
            WHERE m.session_id = ? AND s.workspace_id = ? AND m.role = 'user'
            ORDER BY m.sort_order ASC, m.created_at ASC`
        )
        .all(sessionId, workspaceId)
        .map(nativeMessageShape)
    )
  }
  if (method === 'messages-list-locator') {
    const workspaceId = identifier(args.workspaceId)
    const sessionId = identifier(args.sessionId)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT m.id, m.session_id, m.role, m.content, m.meta, m.created_at, m.sort_order
             FROM messages m JOIN sessions s ON s.id = m.session_id
            WHERE m.session_id = ? AND s.workspace_id = ?
            ORDER BY m.sort_order ASC, m.created_at ASC`
        )
        .all(sessionId, workspaceId)
        .map(nativeMessageShape)
    )
  }
  if (method === 'messages-list-page') {
    const workspaceId = identifier(args.workspaceId)
    const sessionId = identifier(args.sessionId)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT m.id, m.session_id, m.role, m.content, m.meta, m.created_at, m.usage, m.sort_order
             FROM messages m JOIN sessions s ON s.id = m.session_id
            WHERE m.session_id = ? AND s.workspace_id = ?
            ORDER BY m.sort_order ASC, m.created_at ASC
            LIMIT ? OFFSET ?`
        )
        .all(sessionId, workspaceId, limit(args.limit), offset(args.offset))
        .map(nativeMessageShape)
    )
  }
  if (method === 'messages-list-markers') {
    const workspaceId = identifier(args.workspaceId)
    const sessionId = identifier(args.sessionId)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT m.id, m.session_id, m.role, substr(m.content, 1, 512) AS content, m.meta,
                  m.created_at, NULL AS usage, m.sort_order
             FROM messages m JOIN sessions s ON s.id = m.session_id
            WHERE m.session_id = ? AND s.workspace_id = ? AND m.role IN ('user', 'assistant')
            ORDER BY m.sort_order ASC, m.created_at ASC`
        )
        .all(sessionId, workspaceId)
        .map(nativeMessageShape)
    )
  }
  if (method === 'messages-count') {
    const workspaceId = identifier(args.workspaceId)
    const sessionId = identifier(args.sessionId)
    return withSchemaBoundary(() => {
      const row = db
        .prepare(
          `SELECT COALESCE(message_count, 0) AS count
             FROM sessions
            WHERE id = ? AND workspace_id = ?`
        )
        .get(sessionId, workspaceId)
      return Number(row?.count ?? 0)
    })
  }
  if (method === 'messages-request-context') {
    const workspaceId = identifier(args.workspaceId)
    const sessionId = identifier(args.sessionId)
    const maxMessages = contextLimit(args.maxMessages, 160)
    const headLimitInput = args.headLimit ?? 12
    if (!Number.isSafeInteger(headLimitInput)) throw new Error('INVALID_LEGACY_REQUEST')
    const requestedHeadLimit = Math.min(Math.max(headLimitInput, 0), maxMessages)
    return withSchemaBoundary(() => {
      const total = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM messages m JOIN sessions s ON s.id = m.session_id
              WHERE m.session_id = ? AND s.workspace_id = ?`
          )
          .get(sessionId, workspaceId)?.count ?? 0
      )
      if (total <= 0) return []
      const headLimit =
        total > maxMessages ? Math.min(requestedHeadLimit, Math.floor(maxMessages / 4)) : 0
      const tailLimit = Math.min(Math.max(1, maxMessages - headLimit), total)
      const rows = [
        ...(headLimit ? rowPage(sessionId, workspaceId, headLimit, 0) : []),
        ...db
          .prepare(
            `SELECT m.id, m.session_id, m.role, m.content, m.meta, m.created_at, m.usage, m.sort_order
               FROM messages m JOIN sessions s ON s.id = m.session_id
              WHERE m.session_id = ? AND s.workspace_id = ?
                AND (m.meta LIKE '%compactBoundary%' OR m.meta LIKE '%compactSummary%'
                  OR m.content LIKE '%[Context Memory Compressed Summary]%')
              ORDER BY m.sort_order ASC, m.created_at ASC`
          )
          .all(sessionId, workspaceId),
        ...rowPage(sessionId, workspaceId, tailLimit, Math.max(0, total - tailLimit))
      ]
      const seen = new Set()
      return rows
        .sort(
          (left, right) => left.sort_order - right.sort_order || left.created_at - right.created_at
        )
        .filter((row) => !seen.has(row.id) && seen.add(row.id))
        .map(nativeMessageShape)
    })
  }
  if (method === 'messages-window-around') {
    const workspaceId = identifier(args.workspaceId)
    const sessionId = identifier(args.sessionId)
    const windowLimit = contextLimit(args.limit, 30)
    return withSchemaBoundary(() => {
      const total = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM messages m JOIN sessions s ON s.id = m.session_id
              WHERE m.session_id = ? AND s.workspace_id = ?`
          )
          .get(sessionId, workspaceId)?.count ?? 0
      )
      if (total <= 0)
        return {
          success: true,
          rows: [],
          start: 0,
          end: 0,
          total: 0,
          anchorSortOrder: 0
        }
      let anchor = -1
      if (typeof args.messageId === 'string' && args.messageId.trim()) {
        const row = db
          .prepare(
            `SELECT m.sort_order AS sort_order
               FROM messages m JOIN sessions s ON s.id = m.session_id
              WHERE m.session_id = ? AND m.id = ? AND s.workspace_id = ? LIMIT 1`
          )
          .get(sessionId, args.messageId.trim(), workspaceId)
        if (row?.sort_order !== undefined) anchor = Number(row.sort_order)
      }
      if (anchor < 0 && Number.isSafeInteger(args.sortOrder) && args.sortOrder >= 0)
        anchor = args.sortOrder
      anchor = Math.min(Math.max(anchor < 0 ? total - 1 : anchor, 0), total - 1)
      const start = Math.min(
        Math.max(anchor - Math.floor(windowLimit / 2), 0),
        Math.max(0, total - windowLimit)
      )
      const rows = rowPage(sessionId, workspaceId, windowLimit, start)
      return {
        success: true,
        rows,
        start,
        end: rows.length ? start + rows.length : start,
        total,
        anchorSortOrder: anchor
      }
    })
  }
  if (method === 'messages-search-content') {
    const workspaceId = identifier(args.workspaceId)
    const query = searchQuery(args.query)
    return withSchemaBoundary(() =>
      db
        .prepare(
          `SELECT m.session_id AS session_id, m.content AS snippet
             FROM messages m
             JOIN sessions s ON s.id = m.session_id
             JOIN (
               SELECT m2.session_id, MIN(m2.sort_order) AS sort_order
                 FROM messages m2
                 JOIN sessions s2 ON s2.id = m2.session_id
                WHERE s2.workspace_id = ? AND m2.content LIKE ? ESCAPE '\\'
                GROUP BY m2.session_id
             ) first_match ON first_match.session_id = m.session_id
                          AND first_match.sort_order = m.sort_order
            WHERE s.workspace_id = ?
            ORDER BY m.session_id ASC
            LIMIT ?`
        )
        .all(
          workspaceId,
          '%' + escapeLike(query) + '%',
          workspaceId,
          contextLimit(args.limit, 50, 200)
        )
    )
  }
  throw new Error('UNKNOWN_LEGACY_METHOD')
}

parentPort.on('message', ({ id, method, args }) => {
  let snapshotStarted = false
  try {
    if (messageReadsRequiringNormalizedOrder.has(method)) {
      db.exec('BEGIN')
      snapshotStarted = true
    }
    const result = dispatch(method, args)
    if (snapshotStarted) db.exec('COMMIT')
    parentPort.postMessage({ id, result })
  } catch (error) {
    if (snapshotStarted) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The failed read keeps its original error; the next request reopens a snapshot.
      }
    }
    parentPort.postMessage({ id, error: String(error?.message ?? error) })
  }
})
