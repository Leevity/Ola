import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

let repository: BusinessRepository | undefined
let root: string | undefined

afterEach(async () => {
  await repository?.close()
  if (root) await rm(root, { recursive: true, force: true })
  repository = undefined
  root = undefined
})

it('owns plugin session lifecycle and bindings in the TS repository', async () => {
  root = await mkdtemp(join(tmpdir(), 'ola-channel-session-ts-'))
  repository = new BusinessRepository({ path: join(root, 'data.db'), mode: 'direct' })

  await repository.createChannelSession({
    id: 'plugin-session-a',
    pluginId: 'plugin-a',
    title: 'QQ chat',
    mode: 'chat',
    workspaceId: 'team-a',
    externalChatId: 'chat-a',
    createdAt: 1,
    updatedAt: 1
  })
  await repository.addMessages({
    workspaceId: 'team-a',
    messages: [
      {
        id: 'plugin-message-a',
        sessionId: 'plugin-session-a',
        role: 'user',
        content: 'hello',
        createdAt: 1,
        sortOrder: 0
      }
    ]
  })
  await repository.createProject({
    id: 'project-a',
    name: 'Team project',
    workspaceId: 'team-a',
    createdAt: 1,
    updatedAt: 1
  })
  await expect(repository.normalPluginProjects('team-a')).resolves.toEqual([
    expect.objectContaining({ id: 'project-a' })
  ])
  await expect(repository.pluginSessions('plugin-a', 'team-a')).resolves.toHaveLength(1)
  await expect(repository.allPluginSessions('team-a')).resolves.toHaveLength(1)
  await expect(repository.pluginSessionByChat('chat-a', 'team-a')).resolves.toMatchObject({
    id: 'plugin-session-a'
  })
  await expect(
    repository.pluginSessionMessages('plugin-session-a', 'team-a')
  ).resolves.toHaveLength(1)
  await expect(
    repository.renameChannelSession({
      sessionId: 'plugin-session-a',
      workspaceId: 'team-a',
      title: 'Renamed'
    })
  ).resolves.toBe(true)
  await expect(
    repository.clearChannelSession({ sessionId: 'plugin-session-a', workspaceId: 'team-a' })
  ).resolves.toBe(1)
  await expect(
    repository.deleteChannelSession({ sessionId: 'plugin-session-a', workspaceId: 'team-a' })
  ).resolves.toBe(true)
  await expect(
    repository.removePluginData({ pluginId: 'plugin-a', workspaceId: 'team-a' })
  ).resolves.toMatchObject({ success: true })
})
