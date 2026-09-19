import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { createLegacyDatabaseHandoverSnapshot } from '../../src/runtime/storage/legacy-database-handover'
import {
  BusinessRepository,
  type BusinessMessageInput
} from '../../src/runtime/storage/business-repository'

const cleanup: Array<() => Promise<void>> = []

function canonicalMessages(rows: unknown[]): unknown[] {
  return rows.map((value) => {
    const row = value as Record<string, unknown>
    return { ...row, meta: row.meta ?? null, usage: row.usage ?? null }
  })
}

function canonicalMessage(value: unknown): unknown {
  return value == null ? null : canonicalMessages([value])[0]
}

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('continues the complete workspace-scoped message mutation lifecycle after handover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-message-mutation-handover-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const { client, child } = await startWorker(directory)
  cleanup.push(async () => {
    client.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
  const dbPath = join(directory, 'native.db')
  const native = <T>(method: string, args: object = {}): Promise<T> =>
    client.request(method, { dbPath, ...args }) as Promise<T>

  expect((await native<{ success: boolean }>('db/initialize')).success).toBe(true)
  for (const [id, workspaceId] of [
    ['team-a-session', 'team-a'],
    ['team-b-session', 'team-b']
  ]) {
    expect(
      (
        await native<{ success: boolean }>('db/sessions-create', {
          id,
          title: id,
          mode: 'chat',
          createdAt: 1,
          updatedAt: 1,
          workspaceId
        })
      ).success
    ).toBe(true)
  }
  const seed = [
    {
      id: 'a-user',
      sessionId: 'team-a-session',
      workspaceId: 'team-a',
      role: 'user',
      content: 'seed user',
      createdAt: 1,
      sortOrder: 0
    },
    {
      id: 'a-assistant',
      sessionId: 'team-a-session',
      workspaceId: 'team-a',
      role: 'assistant',
      content: 'seed assistant',
      createdAt: 2,
      sortOrder: 1
    },
    {
      id: 'b-user',
      sessionId: 'team-b-session',
      workspaceId: 'team-b',
      role: 'user',
      content: 'team b private',
      createdAt: 1,
      sortOrder: 0
    }
  ]
  expect(
    (
      await native<{ success: boolean; changed: number }>('db/messages-add-batch', {
        messages: seed
      })
    ).changed
  ).toBe(3)

  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backups')
  })
  const repository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => repository.close())
  const rows = () => native<unknown[]>('db/messages-list', { sessionId: 'team-a-session' })
  const tsRows = () => repository.messages('team-a-session', 'team-a')

  const longMessage: BusinessMessageInput = {
    id: 'a-long',
    sessionId: 'team-a-session',
    role: 'user',
    content: 'x'.repeat(2_048),
    createdAt: 3,
    sortOrder: 2
  }
  const nativeAdd = await native<{ success: boolean; changed: number }>('db/messages-add', {
    ...longMessage,
    workspaceId: 'team-a'
  })
  await expect(repository.addMessage({ ...longMessage, workspaceId: 'team-a' })).resolves.toBe(
    nativeAdd.changed
  )
  const nativeDuplicate = await native<{ changed: number }>('db/messages-add', {
    ...longMessage,
    workspaceId: 'team-a'
  })
  await expect(repository.addMessage({ ...longMessage, workspaceId: 'team-a' })).resolves.toBe(
    nativeDuplicate.changed
  )

  const batch: BusinessMessageInput[] = [
    {
      id: 'a-batch-assistant',
      sessionId: 'team-a-session',
      role: 'assistant',
      content: 'batch assistant',
      createdAt: 4,
      sortOrder: 3
    },
    {
      id: 'a-batch-user',
      sessionId: 'team-a-session',
      role: 'user',
      content: 'batch user',
      createdAt: 5,
      sortOrder: 4
    }
  ]
  const nativeBatch = await native<{ changed: number }>('db/messages-add-batch', {
    messages: batch
  })
  await expect(repository.addMessages({ workspaceId: 'team-a', messages: batch })).resolves.toBe(
    nativeBatch.changed
  )
  const patch = {
    content: 'updated'.repeat(400),
    meta: '{"kind":"large"}',
    usage: '{"inputTokens":1}'
  }
  const nativeUpdate = await native<{ changed: number }>('db/messages-update', {
    id: 'a-long',
    patch
  })
  await expect(
    repository.updateMessage({ id: 'a-long', workspaceId: 'team-a', patch })
  ).resolves.toBe(nativeUpdate.changed)
  expect(canonicalMessages(await tsRows())).toEqual(canonicalMessages(await rows()))

  const nativeDeleted = await native<{ message: unknown }>('db/messages-delete-last', {
    sessionId: 'team-a-session',
    role: 'assistant'
  })
  expect(
    canonicalMessage(
      await repository.deleteLastMessage({
        sessionId: 'team-a-session',
        workspaceId: 'team-a',
        role: 'assistant'
      })
    )
  ).toEqual(canonicalMessage(nativeDeleted.message))
  expect(canonicalMessages(await tsRows())).toEqual(canonicalMessages(await rows()))

  const replacement = [
    { id: 'replacement-user', role: 'user', content: 'replacement', createdAt: 10, sortOrder: 0 },
    {
      id: 'old-summary',
      role: 'system',
      content: '[Context Memory Compressed Summary] old',
      meta: '{"compactSummary":true}',
      createdAt: 11,
      sortOrder: 1
    },
    { id: 'replacement-tail', role: 'assistant', content: 'tail', createdAt: 12, sortOrder: 2 }
  ]
  const nativeReplace = await native<{ changed: number }>('db/messages-replace', {
    sessionId: 'team-a-session',
    messages: replacement
  })
  await expect(
    repository.replaceMessages({
      sessionId: 'team-a-session',
      workspaceId: 'team-a',
      messages: replacement
    })
  ).resolves.toBe(nativeReplace.changed)

  const artifacts = [
    {
      id: 'new-summary',
      role: 'system',
      content: '[Context Memory Compressed Summary] new',
      meta: '{"compactSummary":true}',
      createdAt: 13,
      sortOrder: 99
    },
    { id: 'ignored', role: 'system', content: 'not an artifact', createdAt: 13, sortOrder: 99 }
  ]
  const nativeArtifacts = await native<{
    success: boolean
    inserted: number
    start: number
    end: number
    total: number
  }>('db/messages-insert-artifacts', {
    sessionId: 'team-a-session',
    insertSortOrder: 99,
    insertBeforeMessageId: 'replacement-tail',
    messages: artifacts
  })
  await expect(
    repository.insertMessageArtifacts({
      sessionId: 'team-a-session',
      workspaceId: 'team-a',
      insertSortOrder: 99,
      insertBeforeMessageId: 'replacement-tail',
      messages: artifacts
    })
  ).resolves.toMatchObject({
    success: nativeArtifacts.success,
    inserted: nativeArtifacts.inserted,
    start: nativeArtifacts.start,
    end: nativeArtifacts.end,
    total: nativeArtifacts.total
  })
  expect(canonicalMessages(await tsRows())).toEqual(canonicalMessages(await rows()))

  const nativeTruncate = await native<{ changed: number }>('db/messages-truncate-from', {
    sessionId: 'team-a-session',
    fromSortOrder: 2
  })
  await expect(
    repository.truncateMessagesFrom({
      sessionId: 'team-a-session',
      workspaceId: 'team-a',
      fromSortOrder: 2
    })
  ).resolves.toBe(nativeTruncate.changed)
  expect(canonicalMessages(await tsRows())).toEqual(canonicalMessages(await rows()))

  await expect(
    repository.addMessages({
      workspaceId: 'team-a',
      messages: [
        {
          id: 'must-not-commit',
          sessionId: 'team-a-session',
          role: 'user',
          content: 'atomic first item',
          createdAt: 20,
          sortOrder: 2
        },
        {
          id: 'wrong-workspace',
          sessionId: 'team-b-session',
          role: 'user',
          content: 'must reject',
          createdAt: 20,
          sortOrder: 1
        }
      ]
    })
  ).rejects.toThrow('BUSINESS_SESSION_NOT_FOUND')
  await expect(tsRows()).resolves.not.toContainEqual(
    expect.objectContaining({ id: 'must-not-commit' })
  )
  await expect(repository.messages('team-b-session', 'team-a')).resolves.toEqual([])
  await expect(repository.messages('team-b-session', 'team-b')).resolves.toEqual([
    expect.objectContaining({ content: 'team b private' })
  ])

  const nativeClear = await native<{ changed: number }>('db/messages-clear', {
    sessionId: 'team-a-session'
  })
  await expect(repository.clearMessages('team-a-session', 'team-a')).resolves.toBe(
    nativeClear.changed
  )
  await expect(tsRows()).resolves.toEqual([])
  await expect(
    repository.session<{ message_count: number }>('team-a-session', 'team-a')
  ).resolves.toMatchObject({
    message_count: 0
  })
  await expect(repository.clearMessages('team-a-session', 'team-b')).rejects.toThrow(
    'BUSINESS_SESSION_NOT_FOUND'
  )
})
