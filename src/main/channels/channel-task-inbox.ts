import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { DatabaseSync } from 'node:sqlite'

export interface ChannelTaskInboxRow {
  sequence: number
  id: string
  workspaceId: string
  pluginId: string
  chatId: string
  messageId: string | null
  payload: unknown
  status: 'pending' | 'delivered'
}

interface StoredRow {
  sequence: number
  id: string
  workspace_id: string
  plugin_id: string
  chat_id: string
  message_id: string | null
  payload_json: string
  status: 'pending' | 'delivered'
}

export class ChannelTaskInbox {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(dbPath)
    fs.chmodSync(dbPath, 0o600)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_task_inbox (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','delivered')),
        created_at INTEGER NOT NULL,
        last_sent_at INTEGER,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_channel_task_inbox_pending
        ON channel_task_inbox(workspace_id, status, created_at);
    `)
    const columns = this.db.prepare('PRAGMA table_info(channel_task_inbox)').all() as Array<{
      name: string
    }>
    if (!columns.some((column) => column.name === 'last_sent_at'))
      this.db.exec('ALTER TABLE channel_task_inbox ADD COLUMN last_sent_at INTEGER')
  }

  enqueue(input: {
    workspaceId: string
    pluginId: string
    chatId: string
    messageId?: string | null
    payload: unknown
  }): ChannelTaskInboxRow {
    const id = randomUUID()
    const messageId = input.messageId?.trim() || null
    const sourceKey = messageId
      ? JSON.stringify([input.workspaceId, input.pluginId, input.chatId, messageId])
      : id
    this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_task_inbox
         (id,source_key,workspace_id,plugin_id,chat_id,message_id,payload_json,status,created_at)
         VALUES(?,?,?,?,?,?,?,'pending',?)`
      )
      .run(
        id,
        sourceKey,
        input.workspaceId,
        input.pluginId,
        input.chatId,
        messageId,
        JSON.stringify(input.payload),
        Date.now()
      )
    const row = this.db
      .prepare('SELECT rowid AS sequence,* FROM channel_task_inbox WHERE source_key=?')
      .get(sourceKey) as unknown as StoredRow | undefined
    if (!row) throw new Error('CHANNEL_TASK_INBOX_ENQUEUE_FAILED')
    return this.decode(row)
  }

  pending(
    workspaceId: string,
    limit = 100,
    afterSequence = 0,
    retryBefore = Date.now() - 30_000
  ): ChannelTaskInboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT rowid AS sequence,* FROM channel_task_inbox
         WHERE workspace_id=? AND status='pending' AND rowid>?
           AND (last_sent_at IS NULL OR last_sent_at<=?)
         ORDER BY rowid LIMIT ?`
      )
      .all(
        workspaceId,
        afterSequence,
        retryBefore,
        Math.min(Math.max(limit, 1), 1000)
      ) as unknown as StoredRow[]
    return rows.map((row) => this.decode(row))
  }

  nextRetryDelayMs(workspaceId: string, now = Date.now()): number | null {
    const row = this.db
      .prepare(
        `SELECT MIN(COALESCE(last_sent_at + 30000, 0)) AS due_at
         FROM channel_task_inbox WHERE workspace_id=? AND status='pending'`
      )
      .get(workspaceId) as { due_at: number | null }
    return row.due_at === null ? null : Math.max(0, row.due_at - now)
  }

  pendingCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM channel_task_inbox WHERE status='pending'")
      .get() as { count: number }
    return row.count
  }

  markSent(id: string, workspaceId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE channel_task_inbox SET last_sent_at=?
           WHERE id=? AND workspace_id=? AND status='pending'`
        )
        .run(Date.now(), id, workspaceId).changes === 1
    )
  }

  markDelivered(id: string, workspaceId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE channel_task_inbox SET status='delivered',delivered_at=?
           WHERE id=? AND workspace_id=? AND status='pending'`
        )
        .run(Date.now(), id, workspaceId).changes === 1
    )
  }

  close(): void {
    this.db.close()
  }

  private decode(row: StoredRow): ChannelTaskInboxRow {
    return {
      sequence: row.sequence,
      id: row.id,
      workspaceId: row.workspace_id,
      pluginId: row.plugin_id,
      chatId: row.chat_id,
      messageId: row.message_id,
      payload: JSON.parse(row.payload_json) as unknown,
      status: row.status
    }
  }
}
