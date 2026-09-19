import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { createLegacyDatabaseHandoverSnapshot } from '../../src/runtime/storage/legacy-database-handover'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('Native agent change handover', () => {
  it('continues a real Native journal in the isolated TS copy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-native-agent-handover-'))
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
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id: 'team-session',
          title: 'Team',
          mode: 'chat',
          workspaceId: 'team-a'
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/agent-changes-append-file', {
          dbPath,
          workspaceId: 'team-a',
          runId: 'native-run',
          sessionId: 'team-session',
          assistantMessageId: 'assistant-1',
          change: {
            id: 'native-change',
            runId: 'native-run',
            sessionId: 'team-session',
            filePath: '/tmp/native-agent-handover.txt',
            transport: 'local',
            op: 'create',
            status: 'open',
            before: { exists: false, hash: null, size: 0 },
            after: { exists: true, text: 'native', hash: null, size: 6 },
            createdAt: 10
          },
          now: 10
        })
      ).success
    ).toBe(true)
    const legacyReader = new LegacyReadRepository(dbPath)
    try {
      const native = await client.request('db/agent-changes-get', {
        dbPath,
        workspaceId: 'team-a',
        runId: 'native-run'
      })
      expect(await legacyReader.agentChangeSet('native-run', 'team-a')).toEqual(native.changeSet)
      expect(await legacyReader.agentChangeSet('native-run', 'local-personal')).toBeNull()
      expect(await legacyReader.agentChangeSetsBySession('team-session', 'team-a')).toEqual([
        native.changeSet
      ])
    } finally {
      await legacyReader.close()
    }
    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      sourcePath: dbPath,
      backupDirectory: join(directory, 'backups')
    })
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      expect(await repository.agentChangeSet('native-run', 'local-personal')).toBeNull()
      expect(await repository.agentChangeSet('native-run', 'team-a')).toMatchObject({
        changes: [{ id: 'native-change', after: { text: 'native' } }]
      })
      expect(
        await repository.markAgentFileChangeReverted({
          runId: 'native-run',
          workspaceId: 'team-a',
          changeId: 'native-change',
          revertedAt: 11
        })
      ).toBe(true)
      expect(await repository.agentChangeSet('native-run', 'team-a')).toMatchObject({
        status: 'reverted',
        changes: [{ status: 'reverted' }]
      })
      expect(
        (
          await client.request('db/agent-changes-get', {
            dbPath,
            workspaceId: 'team-a',
            runId: 'native-run'
          })
        ).changeSet.status
      ).toBe('open')
    } finally {
      await repository.close()
    }
  }, 30_000)

  it('matches Native retention cleanup across workspaces without deleting open or boundary records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-native-agent-retention-'))
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
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    for (const [sessionId, workspaceId] of [
      ['personal-session', 'local-personal'],
      ['team-session', 'team-a']
    ]) {
      expect(
        (
          await client.request('db/sessions-create', {
            dbPath,
            id: sessionId,
            title: sessionId,
            mode: 'chat',
            workspaceId
          })
        ).success
      ).toBe(true)
    }
    const records = [
      { runId: 'old-reverted', workspaceId: 'team-a', sessionId: 'team-session', revertedAt: 30 },
      {
        runId: 'boundary-reverted',
        workspaceId: 'local-personal',
        sessionId: 'personal-session',
        revertedAt: 31
      },
      { runId: 'old-open', workspaceId: 'team-a', sessionId: 'team-session' },
      {
        runId: 'new-reverted',
        workspaceId: 'local-personal',
        sessionId: 'personal-session',
        revertedAt: 40
      }
    ]
    for (const record of records) {
      expect(
        (
          await client.request('db/agent-changes-append-file', {
            dbPath,
            workspaceId: record.workspaceId,
            runId: record.runId,
            sessionId: record.sessionId,
            assistantMessageId: `assistant-${record.runId}`,
            change: {
              id: `change-${record.runId}`,
              runId: record.runId,
              sessionId: record.sessionId,
              filePath: `/tmp/${record.runId}.txt`,
              transport: 'local',
              op: 'create',
              status: 'open',
              before: { exists: false, hash: null, size: 0 },
              after: { exists: true, text: record.runId, hash: null, size: record.runId.length },
              createdAt: 1
            },
            now: 1
          })
        ).success
      ).toBe(true)
      if (record.revertedAt !== undefined)
        expect(
          (
            await client.request('db/agent-changes-mark-reverted', {
              dbPath,
              workspaceId: record.workspaceId,
              runId: record.runId,
              changeId: `change-${record.runId}`,
              revertedAt: record.revertedAt
            })
          ).success
        ).toBe(true)
    }
    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      sourcePath: dbPath,
      backupDirectory: join(directory, 'backups')
    })
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      expect(
        await client.request('db/agent-changes-delete-finalized-before', { dbPath, cutoff: 31 })
      ).toMatchObject({ success: true, deletedRunCount: 1 })
      expect(await repository.pruneFinalizedAgentChangeSets(31)).toBe(1)
      expect(await repository.pruneFinalizedAgentChangeSets(31)).toBe(0)
      for (const record of records) {
        const native = await client.request('db/agent-changes-get', {
          dbPath,
          workspaceId: record.workspaceId,
          runId: record.runId
        })
        const ts = await repository.agentChangeSet(record.runId, record.workspaceId)
        expect(ts).toEqual(native.changeSet ?? null)
      }
    } finally {
      await repository.close()
    }
  }, 30_000)
})
