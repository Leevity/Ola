import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { chmodSync } from 'node:fs'
import { migrateJournalSchema } from './journal-schema.mjs'

const db = new DatabaseSync(workerData.path)
if (workerData.path !== ':memory:') chmodSync(workerData.path, 0o600)
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
migrateJournalSchema(db)

function run(row) {
  return row
    ? {
        ...JSON.parse(row.spec),
        status: row.status,
        seq: row.seq,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    : null
}
function get(id) {
  return run(db.prepare('SELECT * FROM runs WHERE id=?').get(id))
}
function transaction(callback) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = callback()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
function append(id, type, data, status) {
  const current = get(id)
  if (!current) throw new Error('RUN_NOT_FOUND')
  if (Buffer.byteLength(JSON.stringify(data)) > 256 * 1024) throw new Error('EVENT_TOO_LARGE')
  const timestamp = Date.now()
  const seq = current.seq + 1
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
    id,
    seq,
    type,
    JSON.stringify(data),
    timestamp
  )
  db.prepare('UPDATE runs SET seq=?, status=?, updated_at=? WHERE id=?').run(
    seq,
    status ?? current.status,
    timestamp,
    id
  )
  return {
    runId: id,
    workspaceId: current.workspaceId,
    traceId: current.traceId,
    seq,
    type,
    data,
    timestamp
  }
}
function pendingInteractions(id) {
  return db
    .prepare(
      "SELECT * FROM interactions WHERE run_id=? AND status='pending' ORDER BY created_at, interaction_id"
    )
    .all(id)
    .map((row) => ({
      runId: row.run_id,
      workspaceId: get(row.run_id).workspaceId,
      interactionId: row.interaction_id,
      kind: row.kind,
      payload: JSON.parse(row.payload),
      ...(row.version ? { version: row.version } : {}),
      createdAt: row.created_at
    }))
}
function interactionId(value) {
  if (typeof value !== 'string' || !value || value.length > 256)
    throw new Error('INVALID_INTERACTION')
  return value
}
const SENSITIVE_INTERACTION_FIELD =
  /(?:api[-_]?key|authorization|token|password|secret|cookie|credential|private[-_]?key)/i
const REDACTED_INTERACTION_VALUE = '[REDACTED]'

function publicInteractionPayload(value, depth = 0) {
  if (depth > 32) throw new Error('INVALID_INTERACTION')
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value
  if (Array.isArray(value)) return value.map((item) => publicInteractionPayload(item, depth + 1))
  if (!value || typeof value !== 'object') throw new Error('INVALID_INTERACTION')
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_INTERACTION_FIELD.test(key)
      ? REDACTED_INTERACTION_VALUE
      : publicInteractionPayload(item, depth + 1)
  }
  return output
}
function interactionPayload(value) {
  const payload = publicInteractionPayload(value)
  if (Buffer.byteLength(JSON.stringify(payload)) > 256 * 1024)
    throw new Error('INTERACTION_TOO_LARGE')
  return payload
}
// File registration and terminal status commit together, so recovery cannot strand a partial media run.
function finishExternalArtifact(spec, artifact) {
  if (
    !spec.runId.startsWith('media-result-') ||
    typeof artifact?.path !== 'string' ||
    typeof artifact?.mediaType !== 'string'
  )
    throw new Error('INVALID_EXTERNAL_ARTIFACT')
  const existing = db
    .prepare("SELECT 1 FROM events WHERE run_id=? AND type='artifact.registered' LIMIT 1")
    .get(spec.runId)
  if (!existing)
    append(spec.runId, 'artifact.registered', {
      kind: 'file',
      transport: 'local',
      operation: 'create',
      ...artifact
    })
  if (get(spec.runId).status !== 'completed')
    append(spec.runId, 'run.status', { status: 'completed' }, 'completed')
}
function dispatch(method, args) {
  if (method === 'create' || method === 'external-artifact')
    return transaction(() => {
      const existing = run(
        db
          .prepare('SELECT * FROM runs WHERE request_id=? OR id=?')
          .get(args.spec.requestId, args.spec.runId)
      )
      if (existing) {
        const spec = { ...existing }
        for (const field of ['status', 'seq', 'createdAt', 'updatedAt']) delete spec[field]
        if (JSON.stringify(spec) !== JSON.stringify(args.spec)) throw new Error('REQUEST_CONFLICT')
        if (method === 'external-artifact') finishExternalArtifact(args.spec, args.artifact)
        return { run: get(args.spec.runId), created: false }
      }
      const now = Date.now(),
        spec = args.spec
      const otherWorkspace = db
        .prepare('SELECT 1 FROM runs WHERE session_id=? AND workspace_id<>? LIMIT 1')
        .get(spec.sessionId, spec.workspaceId)
      if (otherWorkspace) throw new Error('SESSION_WORKSPACE_MISMATCH')
      db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)').run(
        spec.runId,
        spec.requestId,
        spec.workspaceId,
        spec.sessionId,
        'queued',
        0,
        JSON.stringify(spec),
        now,
        now
      )
      append(spec.runId, 'run.status', { status: 'queued' }, 'queued')
      if (method === 'external-artifact') finishExternalArtifact(spec, args.artifact)
      return { run: get(spec.runId), created: true }
    })
  if (method === 'append')
    return transaction(() => {
      const current = get(args.runId)
      if (!current || current.workspaceId !== args.workspaceId) throw new Error('RUN_NOT_FOUND')
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status))
        throw new Error('RUN_TERMINAL')
      return append(args.runId, args.type, args.data)
    })
  if (method === 'transition')
    return transaction(() => {
      const current = get(args.runId)
      if (!current || current.workspaceId !== args.workspaceId) throw new Error('RUN_NOT_FOUND')
      if (!args.from.includes(current.status)) return null
      return append(
        args.runId,
        'run.status',
        { status: args.status, ...(args.reason ? { reason: args.reason } : {}) },
        args.status
      )
    })
  if (method === 'snapshot') {
    const current = get(args.runId)
    if (!current || current.workspaceId !== args.workspaceId) return null
    const events = db
      .prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(args.runId, args.afterSeq, args.limit)
    const page = []
    let bytes = Buffer.byteLength(JSON.stringify(current))
    for (const row of events) {
      const event = {
        runId: row.run_id,
        workspaceId: current.workspaceId,
        traceId: current.traceId,
        seq: row.seq,
        type: row.type,
        data: JSON.parse(row.data),
        timestamp: row.timestamp
      }
      const length = Buffer.byteLength(JSON.stringify(event))
      if (bytes + length > 900 * 1024) break
      page.push(event)
      bytes += length
    }
    return { run: current, events: page, pendingInteractions: pendingInteractions(args.runId) }
  }
  if (method === 'list') {
    const values = [args.workspaceId]
    const boundary = (key, inclusive) => {
      if (!key) return ''
      values.push(key.at, key.at, key.id)
      return `AND (created_at < ? OR (created_at=? AND id ${inclusive ? '<=' : '<'} ?))`
    }
    const anchor = boundary(args.anchor, true)
    const after = boundary(args.after, false)
    return db
      .prepare(
        `SELECT * FROM runs WHERE workspace_id=?
         ${args.attentionOnly ? "AND (status IN ('failed','interrupted','waiting_interaction','waiting_capability') OR (status NOT IN ('completed','failed','cancelled','interrupted') AND EXISTS (SELECT 1 FROM interactions i WHERE i.run_id=runs.id AND i.status='pending')))" : ''}
         ${anchor} ${after}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...values, args.limit, args.offset ?? 0)
      .map((row) => {
        const summary = run(row)
        delete summary.prompt
        delete summary.promptImages
        delete summary.history
        delete summary.modelOptions
        return summary
      })
  }
  if (method === 'artifacts-list')
    return db
      .prepare(
        `SELECT e.run_id AS runId,e.seq,e.data,e.timestamp,
                r.session_id AS sessionId,r.status,r.spec
         FROM events e JOIN runs r ON r.id=e.run_id
         LEFT JOIN hidden_artifacts h ON h.run_id=e.run_id AND h.artifact_seq=e.seq
         WHERE r.workspace_id=? AND e.type='artifact.registered'
           AND h.run_id IS NULL
           ${args.runId ? 'AND e.run_id=?' : ''}
         ORDER BY e.timestamp DESC,e.run_id DESC,e.seq DESC
         LIMIT ? OFFSET ?`
      )
      .all(
        ...(args.runId ? [args.workspaceId, args.runId] : [args.workspaceId]),
        args.limit,
        args.offset
      )
      .map((row) => {
        const spec = JSON.parse(row.spec)
        return {
          runId: row.runId,
          seq: row.seq,
          data: JSON.parse(row.data),
          timestamp: row.timestamp,
          sessionId: row.sessionId,
          status: row.status,
          projectId: spec.projectId ?? null,
          workingDirectory: spec.workingDirectory ?? null
        }
      })
  if (method === 'artifact-hide')
    return transaction(() => {
      const artifact = db
        .prepare(
          `SELECT 1 FROM events e JOIN runs r ON r.id=e.run_id
           WHERE e.run_id=? AND e.seq=? AND e.type='artifact.registered'
             AND r.workspace_id=?`
        )
        .get(args.runId, args.seq, args.workspaceId)
      if (!artifact) throw new Error('ARTIFACT_NOT_FOUND')
      db.prepare(
        'INSERT OR IGNORE INTO hidden_artifacts(run_id,artifact_seq,hidden_at) VALUES(?,?,?)'
      ).run(args.runId, args.seq, Date.now())
      return { hidden: true }
    })
  if (method === 'active')
    return db
      .prepare(
        "SELECT * FROM runs WHERE status NOT IN ('completed','failed','cancelled','interrupted') ORDER BY rowid"
      )
      .all()
      .map(run)
  if (method === 'recover')
    return transaction(() => {
      const rows = db
        .prepare(
          "SELECT * FROM runs WHERE status NOT IN ('completed','failed','cancelled','interrupted') ORDER BY rowid"
        )
        .all()
      return rows.map((row) => {
        db.prepare(
          "UPDATE interactions SET status='interrupted', resolved_at=? WHERE run_id=? AND status='pending'"
        ).run(Date.now(), row.id)
        return append(
          row.id,
          'run.status',
          { status: 'interrupted', reason: 'RUNTIME_RESTARTED_REVIEW_SIDE_EFFECTS' },
          'interrupted'
        )
      })
    })
  if (method === 'interaction-create')
    return transaction(() => {
      const current = get(args.runId)
      if (!current || current.workspaceId !== args.workspaceId) throw new Error('RUN_NOT_FOUND')
      if (current.status !== 'running') throw new Error('RUN_NOT_INTERACTIVE')
      const interaction = args.interaction ?? {}
      const id = interactionId(interaction.interactionId)
      if (
        !['question', 'tool-approval', 'plan-approval', 'browser-tool'].includes(interaction.kind)
      )
        throw new Error('INVALID_INTERACTION')
      if (
        interaction.version !== undefined &&
        (typeof interaction.version !== 'string' || interaction.version.length > 256)
      )
        throw new Error('INVALID_INTERACTION')
      const payload = interactionPayload(interaction.payload)
      const createdAt = Date.now()
      db.prepare('INSERT INTO interactions VALUES(?,?,?,?,?,?,?,?,?)').run(
        args.runId,
        id,
        interaction.kind,
        JSON.stringify(payload),
        interaction.version ?? null,
        'pending',
        null,
        createdAt,
        null
      )
      append(
        args.runId,
        'interaction.requested',
        {
          interactionId: id,
          kind: interaction.kind,
          ...(interaction.version ? { version: interaction.version } : {})
        },
        'waiting_interaction'
      )
      return {
        runId: args.runId,
        workspaceId: current.workspaceId,
        interactionId: id,
        kind: interaction.kind,
        payload,
        ...(interaction.version ? { version: interaction.version } : {}),
        createdAt
      }
    })
  if (method === 'interaction-resolve')
    return transaction(() => {
      const current = get(args.runId)
      if (!current || current.workspaceId !== args.workspaceId) throw new Error('RUN_NOT_FOUND')
      if (current.status !== 'waiting_interaction') throw new Error('RUN_NOT_INTERACTIVE')
      const id = interactionId(args.interactionId)
      const row = db
        .prepare(
          "SELECT * FROM interactions WHERE run_id=? AND interaction_id=? AND status='pending'"
        )
        .get(args.runId, id)
      if (!row) throw new Error('INTERACTION_NOT_PENDING')
      const response = interactionPayload(args.response)
      db.prepare(
        "UPDATE interactions SET status='resolved', response=?, resolved_at=? WHERE run_id=? AND interaction_id=?"
      ).run(JSON.stringify(response), Date.now(), args.runId, id)
      const event = append(args.runId, 'interaction.resolved', { interactionId: id }, 'running')
      return {
        interaction: {
          runId: args.runId,
          workspaceId: current.workspaceId,
          interactionId: id,
          kind: row.kind,
          payload: JSON.parse(row.payload),
          ...(row.version ? { version: row.version } : {}),
          createdAt: row.created_at
        },
        event
      }
    })
  if (method === 'interaction-abandon')
    return transaction(() => {
      const current = get(args.runId)
      if (!current || current.workspaceId !== args.workspaceId) throw new Error('RUN_NOT_FOUND')
      const changed = db
        .prepare(
          "UPDATE interactions SET status='abandoned', resolved_at=? WHERE run_id=? AND status='pending'"
        )
        .run(Date.now(), args.runId).changes
      return changed
        ? append(args.runId, 'interaction.abandoned', {
            reason: String(args.reason ?? 'RUN_STOPPED')
          })
        : null
    })
  if (method === 'close') {
    db.close()
    return null
  }
  throw new Error('UNKNOWN_JOURNAL_COMMAND')
}
parentPort.on('message', ({ id, method, args }) => {
  try {
    parentPort.postMessage({ id, result: dispatch(method, args) })
  } catch (error) {
    parentPort.postMessage({ id, error: error.message })
  }
  if (method === 'close') parentPort.close()
})
