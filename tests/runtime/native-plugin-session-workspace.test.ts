import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import { createLegacyDatabaseHandoverSnapshot } from '../../src/runtime/storage/legacy-database-handover'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('Native channel session workspace boundary', () => {
  it('filters reads and atomically scopes mutations to the channel session workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-channel-session-space-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const { client, child } = await startWorker(directory)
    cleanup.push(async () => {
      client.close()
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
    })
    const dbPath = join(directory, 'native.db')
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    for (const [id, workspaceId] of [
      ['personal-session', 'local-personal'],
      ['team-session', 'team-a']
    ]) {
      expect(
        (
          await client.request('db/sessions-create', {
            dbPath,
            id,
            title: id,
            mode: 'cowork',
            pluginId: 'shared-plugin',
            externalChatId: `chat:${id}`,
            workspaceId
          })
        ).success
      ).toBe(true)
    }
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE sessions SET external_chat_id = ? WHERE id = ?').run(
      'chat:team-session',
      'team-session'
    )
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('team-message', 'team-session', 'user', 'team secret', 1, 0)
    db.prepare(
      'INSERT INTO projects (id, name, created_at, updated_at, workspace_id) VALUES (?, ?, ?, ?, ?)'
    ).run('personal-project', 'Personal', 1, 1, 'local-personal')
    db.prepare(
      'INSERT INTO projects (id, name, created_at, updated_at, workspace_id) VALUES (?, ?, ?, ?, ?)'
    ).run('team-project', 'Team', 1, 1, 'team-a')
    db.close()

    const reader = new LegacyReadRepository(dbPath)
    cleanup.push(() => reader.close())
    const nativeTeamRows = await client.request('db/plugin-sessions-list', {
      dbPath,
      pluginId: 'shared-plugin',
      workspaceId: 'team-a'
    })
    const tsTeamRows = await reader.pluginSessions('shared-plugin', 'team-a')
    expect(
      tsTeamRows.map((row) =>
        Object.fromEntries(
          Object.keys(nativeTeamRows[0]).map((key) => [
            key,
            (row as unknown as Record<string, unknown>)[key]
          ])
        )
      )
    ).toEqual(nativeTeamRows)
    const fields = (row: { id: string; title: string; plugin_id: string | null }) => ({
      id: row.id,
      title: row.title,
      plugin_id: row.plugin_id
    })
    expect(tsTeamRows.map(fields)).toEqual(nativeTeamRows.map(fields))
    expect((await reader.allPluginSessions('team-a')).map(fields)).toEqual(
      (await client.request('db/plugin-sessions-list-all', { dbPath, workspaceId: 'team-a' })).map(
        fields
      )
    )
    expect(await reader.pluginSessionByChat('chat:team-session', 'team-a')).toMatchObject({
      id: 'team-session'
    })
    expect(await reader.pluginSessionByChat('chat:team-session', 'local-personal')).toBeNull()
    expect(await reader.pluginSessionMessages('team-session', 'team-a')).toEqual(
      await client.request('db/plugin-sessions-messages', {
        dbPath,
        sessionId: 'team-session',
        workspaceId: 'team-a'
      })
    )

    expect(
      (
        await client.request('db/plugin-sessions-list', {
          dbPath,
          pluginId: 'shared-plugin',
          workspaceId: 'local-personal'
        })
      ).map((row: { id: string }) => row.id)
    ).toEqual(['personal-session'])
    expect(
      (
        await client.request('db/plugin-sessions-list-all', {
          dbPath,
          workspaceId: 'team-a'
        })
      ).map((row: { id: string }) => row.id)
    ).toEqual(['team-session'])
    expect(
      (
        await client.request('db/plugin-sessions-find-by-chat', {
          dbPath,
          externalChatId: 'chat:team-session',
          workspaceId: 'local-personal'
        })
      ).session
    ).toBeUndefined()
    expect(
      await client.request('db/plugin-sessions-messages', {
        dbPath,
        sessionId: 'team-session',
        workspaceId: 'local-personal'
      })
    ).toEqual([])
    for (const method of [
      'db/plugin-sessions-rename',
      'db/plugin-sessions-clear',
      'db/plugin-sessions-delete'
    ]) {
      const result = await client.request(method, {
        dbPath,
        sessionId: 'team-session',
        title: 'wrong space',
        workspaceId: 'local-personal'
      })
      expect(result.success).toBe(true)
      expect(result.changed).toBe(0)
      expect(result.deleted).toBe(0)
    }
    expect(
      (
        await client.request('db/plugin-sessions-find-by-chat', {
          dbPath,
          externalChatId: 'chat:team-session',
          workspaceId: 'team-a'
        })
      ).session.title
    ).toBe('team-session')
    expect(
      (
        await client.request('db/plugin-sessions-messages', {
          dbPath,
          sessionId: 'team-session',
          workspaceId: 'team-a'
        })
      ).map((row: { content: string }) => row.content)
    ).toEqual(['team secret'])

    expect(
      (
        await client.request('db/plugin-sessions-rename', {
          dbPath,
          sessionId: 'team-session',
          title: 'Renamed team session',
          workspaceId: 'team-a'
        })
      ).changed
    ).toBe(1)
    expect(
      (
        await client.request('db/plugin-sessions-clear', {
          dbPath,
          sessionId: 'team-session',
          workspaceId: 'team-a'
        })
      ).deleted
    ).toBe(1)
    expect(
      (
        await client.request('db/plugin-sessions-create', {
          dbPath,
          id: 'new-team-session',
          pluginId: 'shared-plugin',
          title: 'New team session',
          mode: 'cowork',
          workspaceId: 'team-a'
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/sessions-get', {
          dbPath,
          id: 'new-team-session',
          workspaceId: 'team-a'
        })
      ).session.workspace_id
    ).toBe('team-a')
    expect(
      (
        await client.request('db/plugin-sessions-create', {
          dbPath,
          id: 'cross-project-session',
          pluginId: 'shared-plugin',
          title: 'Cross project',
          projectId: 'personal-project',
          workspaceId: 'team-a'
        })
      ).success
    ).toBe(false)

    const firstRoute = await client.request('db/plugin-route-session', {
      dbPath,
      pluginId: 'shared-plugin',
      chatId: 'routed-chat',
      chatName: 'New Chat',
      workspaceId: 'team-a',
      projectId: 'team-project'
    })
    expect(firstRoute).toMatchObject({ success: true, projectId: 'team-project' })
    const secondRoute = await client.request('db/plugin-route-session', {
      dbPath,
      pluginId: 'shared-plugin',
      chatId: 'routed-chat',
      chatName: 'Better title',
      workspaceId: 'team-a',
      projectId: 'team-project',
      modelSource: JSON.stringify({
        kind: 'ola-team',
        workspaceId: 'team-a',
        resourceId: 'resource-a'
      })
    })
    expect(secondRoute).toMatchObject({
      success: true,
      sessionId: firstRoute.sessionId,
      sessionTitle: 'Better title'
    })
    expect(
      (
        await client.request('db/sessions-get', {
          dbPath,
          id: firstRoute.sessionId,
          workspaceId: 'team-a'
        })
      ).session.model_source
    ).toContain('resource-a')
    expect(
      (
        await client.request('db/plugin-route-session', {
          dbPath,
          pluginId: 'shared-plugin',
          chatId: 'routed-chat',
          workspaceId: 'local-personal'
        })
      ).success
    ).toBe(false)

    const resetDb = new DatabaseSync(dbPath)
    const staleToolResult = JSON.stringify([{ type: 'tool_result', content: 'x'.repeat(220) }])
    resetDb
      .prepare(
        'INSERT INTO messages (id, session_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('new-team-message', 'new-team-session', 'user', staleToolResult, 2, 0)
    resetDb
      .prepare(
        'INSERT INTO messages (id, session_id, role, content, created_at, usage, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'new-team-usage',
        'new-team-session',
        'assistant',
        JSON.stringify([{ type: 'thinking', thinking: 'private reasoning', extra: 1 }]),
        3,
        '{"inputTokens":10,"outputTokens":4}',
        1
      )
    const insertFiller = resetDb.prepare(
      'INSERT INTO messages (id, session_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (let index = 0; index < 6; index++) {
      insertFiller.run(
        `team-filler-${index}`,
        'new-team-session',
        'user',
        'filler',
        index + 4,
        index + 2
      )
    }
    resetDb.prepare('UPDATE messages SET role=?, usage=? WHERE id=?').run(
      'assistant',
      JSON.stringify({
        inputTokens: 50,
        billableInputTokens: '12',
        outputTokens: 7,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        reasoningTokens: 3,
        totalDurationMs: 120,
        requestTimings: [{}, {}]
      }),
      'team-filler-0'
    )
    resetDb
      .prepare('UPDATE messages SET role=?, usage=? WHERE id=?')
      .run('assistant', 'not-json', 'team-filler-1')
    resetDb.close()
    await expect(reader.channelSessionStatus('new-team-session', 'team-a')).resolves.toEqual(
      await client.request('db/session-status', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'team-a'
      })
    )
    await expect(reader.channelSessionUsageStats('new-team-session', 'team-a')).resolves.toEqual(
      await client.request('db/messages-usage-stats', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'team-a'
      })
    )
    await expect(
      reader.channelSessionUsageStats('new-team-session', 'local-personal')
    ).resolves.toEqual(
      await client.request('db/messages-usage-stats', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'local-personal'
      })
    )
    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      sourcePath: dbPath,
      backupDirectory: join(directory, 'handover-backups')
    })
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    cleanup.push(() => repository.close())
    await expect(
      repository.sessionStatus({ sessionId: 'new-team-session', workspaceId: 'team-a' })
    ).resolves.toEqual(
      await client.request('db/session-status', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'team-a'
      })
    )
    await expect(
      repository.sessionUsageStats({ sessionId: 'new-team-session', workspaceId: 'team-a' })
    ).resolves.toEqual(
      await client.request('db/messages-usage-stats', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'team-a'
      })
    )
    await expect(
      repository.sessionUsageStats({ sessionId: 'new-team-session', workspaceId: 'local-personal' })
    ).resolves.toEqual(
      await client.request('db/messages-usage-stats', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'local-personal'
      })
    )
    expect(
      await client.request('db/session-status', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'local-personal'
      })
    ).toMatchObject({ success: true, found: false, messageCount: 0 })
    expect(
      await client.request('db/session-status', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'team-a'
      })
    ).toMatchObject({ success: true, found: true, messageCount: 8 })
    expect(
      await client.request('db/messages-usage-stats', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'local-personal'
      })
    ).toMatchObject({ success: true, hasUsage: false, totalInput: 0 })
    expect(
      await client.request('db/messages-usage-stats', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'team-a'
      })
    ).toMatchObject({
      success: true,
      hasUsage: true,
      totalInput: 22,
      totalOutput: 11,
      totalCacheRead: 10,
      totalCacheCreation: 5,
      totalReasoning: 3,
      totalDurationMs: 120,
      requestCount: 3,
      assistantReplies: 2
    })
    expect(
      await client.request('db/messages-compact-session', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'local-personal'
      })
    ).toMatchObject({ success: true, totalMessages: 0, compacted: 0 })
    await expect(
      repository.compactSessionMessages({
        sessionId: 'new-team-session',
        workspaceId: 'local-personal'
      })
    ).resolves.toMatchObject({ success: true, totalMessages: 0, compacted: 0 })
    expect(
      (
        await client.request('db/plugin-sessions-messages', {
          dbPath,
          sessionId: 'new-team-session',
          workspaceId: 'team-a'
        })
      )[0].content
    ).toBe(staleToolResult)
    const nativeCompaction = await client.request('db/messages-compact-session', {
      dbPath,
      sessionId: 'new-team-session',
      workspaceId: 'team-a'
    })
    expect(nativeCompaction).toMatchObject({ success: true, totalMessages: 8, compacted: 2 })
    await expect(
      repository.compactSessionMessages({ sessionId: 'new-team-session', workspaceId: 'team-a' })
    ).resolves.toEqual(nativeCompaction)
    expect(
      await client.request('db/session-reset-conversation', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'local-personal'
      })
    ).toMatchObject({ success: false, deletedMessages: 0 })
    const compactedMessages = await client.request('db/plugin-sessions-messages', {
      dbPath,
      sessionId: 'new-team-session',
      workspaceId: 'team-a'
    })
    expect(compactedMessages).toHaveLength(8)
    await expect(
      repository.messages<{ content: string }>('new-team-session', 'team-a')
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ content: compactedMessages[0].content })])
    )
    expect(JSON.parse(compactedMessages[0].content)[0].content).toContain(
      'stale tool result cleared'
    )
    expect(compactedMessages[0].content).not.toContain('x'.repeat(220))
    expect(JSON.parse(compactedMessages[1].content)[0]).toEqual({
      type: 'thinking',
      extra: 1,
      thinking: '[Thinking cleared during compression]'
    })
    expect(
      await client.request('db/session-reset-conversation', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'team-a'
      })
    ).toMatchObject({ success: true, deletedMessages: 8 })
    expect(
      await client.request('db/plugin-sessions-messages', {
        dbPath,
        sessionId: 'new-team-session',
        workspaceId: 'team-a'
      })
    ).toEqual([])
    expect(
      (
        await client.request('db/sessions-get', {
          dbPath,
          id: 'new-team-session',
          workspaceId: 'team-a'
        })
      ).session.title
    ).toBe('New Conversation')

    expect(
      (
        await client.request('db/plugin-remove-data', {
          dbPath,
          pluginId: 'shared-plugin',
          workspaceId: 'team-a'
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/plugin-sessions-list-all', {
          dbPath,
          workspaceId: 'local-personal'
        })
      ).map((row: { id: string }) => row.id)
    ).toEqual(['personal-session'])
    expect(
      await client.request('db/plugin-sessions-list-all', { dbPath, workspaceId: 'team-a' })
    ).toEqual([])
  })
})
