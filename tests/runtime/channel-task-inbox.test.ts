import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ChannelTaskInbox } from '../../src/main/channels/channel-task-inbox'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('persistent channel task inbox', () => {
  it('adds the retry timestamp to an existing inbox without dropping pending rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-channel-inbox-migrate-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const dbPath = join(directory, 'inbox.sqlite')
    const old = new DatabaseSync(dbPath)
    old.exec(`
      CREATE TABLE channel_task_inbox (
        id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL, plugin_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        message_id TEXT, payload_json TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, delivered_at INTEGER
      );
      INSERT INTO channel_task_inbox VALUES
        ('old-task','old-source','team-a','plugin-a','chat-a','message-a',
         '{"content":"preserved"}','pending',1,NULL);
    `)
    old.close()
    const inbox = new ChannelTaskInbox(dbPath)
    cleanup.push(async () => inbox.close())
    expect(inbox.pending('team-a')).toMatchObject([
      { id: 'old-task', payload: { content: 'preserved' } }
    ])
    expect(inbox.markSent('old-task', 'team-a')).toBe(true)
    const retryDelay = inbox.nextRetryDelayMs('team-a')
    expect(retryDelay).not.toBeNull()
    expect(retryDelay!).toBeGreaterThan(29_000)
    expect(retryDelay!).toBeLessThanOrEqual(30_000)
  })

  it('retains undelivered tasks across reopen and deduplicates by workspace, plugin and chat', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-channel-inbox-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const dbPath = join(directory, 'private', 'inbox.sqlite')
    let inbox = new ChannelTaskInbox(dbPath)
    cleanup.push(async () => inbox.close())
    const input = {
      workspaceId: 'team-a',
      pluginId: 'plugin-a',
      chatId: 'chat-a',
      messageId: 'source-1',
      payload: { content: 'private team content' }
    }
    const first = inbox.enqueue(input)
    expect(inbox.enqueue({ ...input, payload: { content: 'replayed' } }).id).toBe(first.id)
    const second = inbox.enqueue({ ...input, chatId: 'chat-b' })
    const third = inbox.enqueue({ ...input, pluginId: 'plugin-b' })
    const local = inbox.enqueue({ ...input, workspaceId: 'local-personal' })
    expect(inbox.pendingCount()).toBe(4)
    expect(new Set([first.id, second.id, third.id, local.id]).size).toBe(4)
    expect(inbox.pending('team-a', 2).map((row) => row.id)).toEqual([first.id, second.id])
    expect(inbox.nextRetryDelayMs('team-a')).toBe(0)
    expect(inbox.nextRetryDelayMs('missing')).toBeNull()
    expect(inbox.pending('team-a', 2, second.sequence).map((row) => row.id)).toEqual([third.id])
    expect(inbox.pending('local-personal').map((row) => row.id)).toEqual([local.id])
    expect((await stat(dbPath)).mode & 0o777).toBe(0o600)

    inbox.close()
    inbox = new ChannelTaskInbox(dbPath)
    expect(inbox.pending('team-a').map((row) => row.payload)).toEqual([
      { content: 'private team content' },
      input.payload,
      input.payload
    ])
    expect(inbox.markDelivered(first.id, 'local-personal')).toBe(false)
    expect(inbox.markSent(first.id, 'team-a')).toBe(true)
    expect(inbox.nextRetryDelayMs('team-a')).toBe(0)
    expect(inbox.nextRetryDelayMs('local-personal')).toBe(0)
    expect(inbox.pending('team-a').map((row) => row.id)).toEqual([second.id, third.id])
    expect(inbox.pending('team-a', 100, 0, Date.now() + 1).map((row) => row.id)).toEqual([
      first.id,
      second.id,
      third.id
    ])
    expect(inbox.markDelivered(first.id, 'team-a')).toBe(true)
    expect(inbox.pendingCount()).toBe(3)
    expect(inbox.markDelivered(first.id, 'team-a')).toBe(false)
    expect(inbox.enqueue(input)).toMatchObject({ id: first.id, status: 'delivered' })
    expect(inbox.pending('team-a').map((row) => row.id)).toEqual([second.id, third.id])
  })
})
