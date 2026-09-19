import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { createLegacyDatabaseHandoverSnapshot } from '../../src/runtime/storage/legacy-database-handover'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('TS channel sessions on a Native handover copy', () => {
  it('preserves channel behavior and rejects cross-workspace associations and message IDs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-ts-channel-handover-'))
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
      ['local-channel', 'local-personal'],
      ['team-channel', 'team-a']
    ]) {
      expect(
        (
          await client.request('db/sessions-create', {
            dbPath,
            id,
            title: id,
            mode: 'cowork',
            pluginId: 'shared-plugin',
            workspaceId
          })
        ).success
      ).toBe(true)
    }
    const source = new DatabaseSync(dbPath)
    source
      .prepare('UPDATE sessions SET external_chat_id=? WHERE id=?')
      .run('chat:team', 'team-channel')
    source
      .prepare(
        'INSERT INTO messages(id,session_id,role,content,created_at,sort_order) VALUES(?,?,?,?,?,?)'
      )
      .run('team-message', 'team-channel', 'user', 'private team message', 1, 0)
    source
      .prepare('INSERT INTO projects(id,name,created_at,updated_at,workspace_id) VALUES(?,?,?,?,?)')
      .run('local-project', 'Local', 1, 1, 'local-personal')
    source
      .prepare(
        `INSERT INTO projects(id,name,working_folder,created_at,updated_at,workspace_id)
         VALUES(?,?,?,?,?,?)`
      )
      .run('team-project', 'Team', '/tmp/team-project', 1, 1, 'team-a')
    source.close()

    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      sourcePath: dbPath,
      backupDirectory: join(directory, 'backups')
    })
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    cleanup.push(() => repository.close())

    expect(
      (await repository.channelSessions<{ id: string }>('shared-plugin', 'team-a')).map(
        (row) => row.id
      )
    ).toEqual(['team-channel'])
    expect(
      (await repository.channelSessions<{ id: string }>('shared-plugin', 'local-personal')).map(
        (row) => row.id
      )
    ).toEqual(['local-channel'])
    await expect(repository.channelSessionByChat('chat:team', 'local-personal')).resolves.toBeNull()
    await expect(repository.channelSessionByChat('chat:team', 'team-a')).resolves.toMatchObject({
      id: 'team-channel'
    })
    await expect(
      repository.channelSessionMessages('team-channel', 'local-personal')
    ).resolves.toEqual([])
    await expect(
      repository.channelSessionMessages('team-channel', 'team-a')
    ).resolves.toMatchObject([{ id: 'team-message', content: 'private team message' }])
    await expect(
      repository.createChannelSession({
        id: 'bad-team-channel',
        pluginId: 'shared-plugin',
        title: 'Bad team channel',
        workspaceId: 'team-a',
        projectId: 'local-project'
      })
    ).rejects.toThrow('BUSINESS_CHANNEL_PROJECT_NOT_FOUND')
    await expect(
      repository.createSession({
        id: 'bad-team-session',
        title: 'Bad team session',
        mode: 'chat',
        workspaceId: 'team-a',
        projectId: 'local-project',
        createdAt: 1,
        updatedAt: 1
      })
    ).rejects.toThrow('BUSINESS_PROJECT_NOT_FOUND')
    const parityInput = {
      pluginId: 'shared-plugin',
      chatId: 'parity / chat%',
      chatName: 'Parity chat',
      workspaceId: 'team-a',
      projectId: 'team-project'
    }
    const nativeRoute = await client.request('db/plugin-route-session', {
      dbPath,
      ...parityInput
    })
    expect(nativeRoute.success).toBe(true)
    const tsRoute = await repository.routeChannelSession(parityInput)
    expect(tsRoute).toMatchObject({
      sessionTitle: nativeRoute.sessionTitle,
      projectId: nativeRoute.projectId,
      workingFolder: nativeRoute.workingFolder ?? null,
      sshConnectionId: nativeRoute.sshConnectionId ?? null
    })
    await expect(
      repository.routeChannelSession({
        pluginId: 'shared-plugin',
        chatId: 'new-chat',
        workspaceId: 'team-a',
        projectId: 'local-project'
      })
    ).rejects.toThrow('BUSINESS_CHANNEL_PROJECT_WORKSPACE_MISMATCH')
    const routed = await repository.routeChannelSession({
      pluginId: 'shared-plugin',
      chatId: 'new-chat',
      chatName: 'New Chat',
      workspaceId: 'team-a',
      projectId: 'team-project',
      modelSource: JSON.stringify({
        kind: 'ola-team',
        workspaceId: 'team-a',
        resourceId: 'resource-a'
      })
    })
    expect(routed).toMatchObject({
      sessionTitle: 'New Chat',
      projectId: 'team-project',
      workingFolder: '/tmp/team-project'
    })
    expect(
      await repository.routeChannelSession({
        pluginId: 'shared-plugin',
        chatId: 'new-chat',
        chatName: 'Better title',
        workspaceId: 'team-a',
        projectId: 'team-project'
      })
    ).toMatchObject({ sessionId: routed.sessionId, sessionTitle: 'Better title' })
    await expect(
      repository.routeChannelSession({
        pluginId: 'shared-plugin',
        chatId: 'new-chat',
        workspaceId: 'local-personal'
      })
    ).rejects.toThrow('BUSINESS_CHANNEL_SESSION_WORKSPACE_MISMATCH')
    await expect(repository.session(routed.sessionId, 'team-a')).resolves.toMatchObject({
      external_chat_id: 'plugin:shared-plugin:chat:new-chat',
      project_id: 'team-project'
    })
    await expect(
      repository.routeChannelSession({
        pluginId: 'shared-plugin',
        chatId: 'invalid-model',
        workspaceId: 'team-a',
        modelSource: JSON.stringify({
          kind: 'ola-team',
          workspaceId: 'team-b',
          resourceId: 'resource-b'
        })
      })
    ).rejects.toThrow('INVALID_BUSINESS_CHANNEL_MODEL_SOURCE')
    await repository.createChannelSession({
      id: 'legacy-team-channel',
      pluginId: 'shared-plugin',
      title: 'Legacy title',
      workspaceId: 'team-a',
      externalChatId: 'plugin:shared-plugin:chat:legacy:message:old'
    })
    await expect(
      repository.routeChannelSession({
        pluginId: 'shared-plugin',
        chatId: 'legacy',
        workspaceId: 'team-a'
      })
    ).resolves.toMatchObject({ sessionId: 'legacy-team-channel' })
    await expect(repository.session('legacy-team-channel', 'team-a')).resolves.toMatchObject({
      external_chat_id: 'plugin:shared-plugin:chat:legacy'
    })
    await expect(
      repository.upsertMessage({
        id: 'team-message',
        sessionId: 'local-channel',
        workspaceId: 'local-personal',
        role: 'assistant',
        content: 'overwrite attempt',
        createdAt: 2,
        updatedAt: 2,
        sortOrder: 0
      })
    ).rejects.toThrow('BUSINESS_MESSAGE_SESSION_MISMATCH')
    await expect(
      repository.channelSessionMessages('team-channel', 'team-a')
    ).resolves.toMatchObject([{ content: 'private team message' }])

    await expect(
      repository.renameChannelSession({
        sessionId: 'team-channel',
        workspaceId: 'local-personal',
        title: 'wrong workspace'
      })
    ).resolves.toBe(false)
    await expect(
      repository.clearChannelSession({ sessionId: 'team-channel', workspaceId: 'local-personal' })
    ).resolves.toBe(0)
    await expect(
      repository.deleteChannelSession({ sessionId: 'team-channel', workspaceId: 'local-personal' })
    ).resolves.toBe(false)
    await expect(
      repository.renameChannelSession({
        sessionId: 'team-channel',
        workspaceId: 'team-a',
        title: 'Team renamed'
      })
    ).resolves.toBe(true)
    await expect(
      repository.clearChannelSession({ sessionId: 'team-channel', workspaceId: 'team-a' })
    ).resolves.toBe(1)
    await expect(repository.channelSessionMessages('team-channel', 'team-a')).resolves.toEqual([])
    await expect(
      repository.createChannelSession({
        id: 'new-team-channel',
        pluginId: 'shared-plugin',
        title: 'New team channel',
        workspaceId: 'team-a'
      })
    ).resolves.toMatchObject({ workspace_id: 'team-a', plugin_id: 'shared-plugin' })
    await expect(
      repository.deleteChannelSession({ sessionId: 'team-channel', workspaceId: 'team-a' })
    ).resolves.toBe(true)
    await expect(repository.channelSessionByChat('chat:team', 'team-a')).resolves.toBeNull()
    await expect(
      repository.channelSessions('shared-plugin', 'local-personal')
    ).resolves.toHaveLength(1)
    await expect(repository.allChannelSessions('team-a')).resolves.toHaveLength(4)
    await expect(
      repository.removeChannelData({ pluginId: 'shared-plugin', workspaceId: 'team-a' })
    ).resolves.toMatchObject({ changed: 4, deleted: 0 })
    await expect(repository.allChannelSessions('team-a')).resolves.toEqual([])
    await expect(repository.allChannelSessions('local-personal')).resolves.toHaveLength(1)

    const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
    expect(
      nativeSource.prepare('SELECT content FROM messages WHERE id=?').get('team-message')
    ).toEqual({ content: 'private team message' })
    expect(nativeSource.prepare('SELECT id FROM sessions WHERE id=?').get('new-team-channel')).toBe(
      undefined
    )
    nativeSource.close()
  })
})
