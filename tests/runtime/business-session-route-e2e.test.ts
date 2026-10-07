import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

describe('TS business session route integration', () => {
  let root: string | undefined
  let repository: BusinessRepository | undefined

  afterEach(async () => {
    await repository?.close()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('executes status, usage, compaction and reset through the TS SQLite worker', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-business-session-e2e-'))
    repository = new BusinessRepository({
      path: join(root, 'data.db'),
      mode: 'direct'
    })

    const now = Date.now()
    await repository.createSession({
      id: 'session-a',
      title: 'Personal session',
      mode: 'chat',
      createdAt: now,
      updatedAt: now,
      workspaceId: 'local-personal'
    })
    await repository.createSession({
      id: 'session-team',
      title: 'Team session must not leak',
      mode: 'chat',
      createdAt: now,
      updatedAt: now,
      workspaceId: 'team-a'
    })

    await repository.addMessages({
      workspaceId: 'local-personal',
      messages: Array.from({ length: 8 }, (_, index) => ({
        id: `message-${index}`,
        sessionId: 'session-a',
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index} `.repeat(30),
        createdAt: now + index,
        sortOrder: index,
        usage:
          index % 2 === 0
            ? null
            : JSON.stringify({
                inputTokens: 100,
                outputTokens: 20,
                totalDurationMs: 50,
                requestTimings: [{ durationMs: 50 }]
              })
      }))
    })

    await expect(
      repository.sessionStatus({ sessionId: 'session-team', workspaceId: 'local-personal' })
    ).resolves.toMatchObject({
      success: true,
      found: false,
      messageCount: 0
    })
    await expect(
      repository.sessionStatus({ sessionId: 'session-a', workspaceId: 'local-personal' })
    ).resolves.toMatchObject({
      success: true,
      found: true,
      title: 'Personal session',
      messageCount: 8
    })
    await expect(
      repository.sessionUsageStats({ sessionId: 'session-a', workspaceId: 'local-personal' })
    ).resolves.toMatchObject({
      success: true,
      hasUsage: true,
      totalInput: 400,
      totalOutput: 80,
      assistantReplies: 4,
      requestCount: 4
    })
    await expect(
      repository.compactSessionMessages({ sessionId: 'session-a', workspaceId: 'local-personal' })
    ).resolves.toMatchObject({ success: true, totalMessages: 8, compacted: 0 })
    await expect(
      repository.resetConversation({ sessionId: 'session-a', workspaceId: 'local-personal' })
    ).resolves.toMatchObject({ success: true, deletedMessages: 8 })
    await expect(
      repository.sessionStatus({ sessionId: 'session-a', workspaceId: 'local-personal' })
    ).resolves.toMatchObject({ success: true, found: true, messageCount: 0 })
  })

  it('persists task profile and lock state across session reads', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-business-session-profile-'))
    repository = new BusinessRepository({ path: join(root, 'data.db'), mode: 'direct' })
    const now = Date.now()
    await repository.createSession({
      id: 'profile-session',
      title: 'Profile session',
      mode: 'chat',
      taskProfile: 'code',
      taskProfileLocked: false,
      createdAt: now,
      updatedAt: now,
      workspaceId: 'local-personal'
    })

    await expect(
      repository.session<{ task_profile: string; task_profile_locked: number }>(
        'profile-session',
        'local-personal'
      )
    ).resolves.toMatchObject({ task_profile: 'code', task_profile_locked: 0 })

    await repository.updateSession({
      id: 'profile-session',
      workspaceId: 'local-personal',
      taskProfile: 'work',
      taskProfileLocked: true,
      updatedAt: now + 1
    })

    await expect(
      repository.session<{ task_profile: string; task_profile_locked: number }>(
        'profile-session',
        'local-personal'
      )
    ).resolves.toMatchObject({ task_profile: 'work', task_profile_locked: 1 })
  })
})
