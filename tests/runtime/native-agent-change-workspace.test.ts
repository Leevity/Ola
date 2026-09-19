import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ola-agent-change-workspace-'))
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
          mode: 'chat',
          workspaceId
        })
      ).success
    ).toBe(true)
  }
  return { client, dbPath }
}

function appendArgs(dbPath: string, workspaceId = 'team-a', sessionId = 'team-session') {
  return {
    dbPath,
    workspaceId,
    runId: 'team-run',
    sessionId,
    assistantMessageId: 'assistant-1',
    change: {
      id: 'team-change',
      runId: 'team-run',
      sessionId,
      filePath: '/tmp/team-file.txt',
      transport: 'local',
      op: 'create',
      status: 'open',
      before: { exists: false, hash: null, size: 0 },
      after: { exists: true, text: 'team', hash: null, size: 4 },
      createdAt: 1000
    },
    now: 1000
  }
}

describe('Native agent change workspace boundary', () => {
  it('rejects spoofed append and isolates read, list, revert, recompute and run collisions', async () => {
    const { client, dbPath } = await setup()
    expect(
      (await client.request('db/agent-changes-append-file', appendArgs(dbPath, 'local-personal')))
        .success
    ).toBe(false)
    expect((await client.request('db/agent-changes-append-file', appendArgs(dbPath))).success).toBe(
      true
    )
    expect(
      (
        await client.request('db/agent-changes-get', {
          dbPath,
          runId: 'team-run',
          workspaceId: 'team-a'
        })
      ).changeSet.changes
    ).toHaveLength(1)
    expect(
      (
        await client.request('db/agent-changes-get', {
          dbPath,
          runId: 'team-run',
          workspaceId: 'local-personal'
        })
      ).changeSet
    ).toBeUndefined()
    expect(
      await client.request('db/agent-changes-list-session', {
        dbPath,
        sessionId: 'team-session',
        workspaceId: 'local-personal'
      })
    ).toMatchObject({ error: expect.any(String) })
    expect(
      await client.request('db/agent-changes-list-session', {
        dbPath,
        sessionId: 'team-session',
        workspaceId: 'team-a'
      })
    ).toHaveLength(1)
    expect(
      (
        await client.request('agent-changes/list-session-hydrated', {
          dbPath,
          sessionId: 'team-session',
          workspaceId: 'local-personal'
        })
      ).success
    ).toBe(false)
    expect(
      (
        await client.request('agent-changes/get-hydrated', {
          dbPath,
          runId: 'team-run',
          workspaceId: 'local-personal'
        })
      ).changeSet
    ).toBeUndefined()
    expect(
      (
        await client.request('agent-changes/diff-local', {
          dbPath,
          runId: 'team-run',
          changeId: 'team-change',
          workspaceId: 'local-personal'
        })
      ).notFound
    ).toBe(true)
    expect(
      (
        await client.request('agent-changes/rollback-local-change', {
          dbPath,
          runId: 'team-run',
          changeId: 'team-change',
          workspaceId: 'local-personal',
          change: { ...appendArgs(dbPath).change, filePath: '/tmp/forged-delete.txt' }
        })
      ).success
    ).toBe(false)
    for (const method of ['db/agent-changes-mark-reverted', 'db/agent-changes-recompute']) {
      expect(
        (
          await client.request(method, {
            dbPath,
            runId: 'team-run',
            changeId: 'team-change',
            workspaceId: 'local-personal'
          })
        ).success
      ).toBe(false)
    }
    expect(
      (
        await client.request('db/agent-changes-append-file', {
          ...appendArgs(dbPath, 'local-personal', 'personal-session'),
          change: { ...appendArgs(dbPath).change, id: 'collision', sessionId: 'personal-session' }
        })
      ).success
    ).toBe(false)
    expect(
      (
        await client.request('db/agent-changes-get', {
          dbPath,
          runId: 'team-run',
          workspaceId: 'team-a'
        })
      ).changeSet.changes
    ).toHaveLength(1)
  }, 30_000)

  it('backfills old change-set ownership from persisted sessions', async () => {
    const { client, dbPath } = await setup()
    expect((await client.request('db/agent-changes-append-file', appendArgs(dbPath))).success).toBe(
      true
    )
    const database = new DatabaseSync(dbPath)
    try {
      database.exec('DROP INDEX idx_agent_change_sets_workspace_created')
      database.exec('ALTER TABLE agent_change_sets DROP COLUMN workspace_id')
    } finally {
      database.close()
    }
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    expect(
      (
        await client.request('db/agent-changes-get', {
          dbPath,
          runId: 'team-run',
          workspaceId: 'team-a'
        })
      ).changeSet.changes
    ).toHaveLength(1)
    expect(
      (
        await client.request('db/agent-changes-get', {
          dbPath,
          runId: 'team-run',
          workspaceId: 'local-personal'
        })
      ).changeSet
    ).toBeUndefined()
  }, 30_000)
})
