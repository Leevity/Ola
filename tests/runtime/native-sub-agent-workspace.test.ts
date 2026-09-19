import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('Native sub-agent history workspace boundary', () => {
  it('uses persisted session ownership for index, snapshots and mutations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-sub-agent-workspace-'))
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
    const item = {
      dbPath,
      id: 'team-history',
      sessionId: 'team-session',
      subAgentId: 'agent-a',
      toolUseId: 'tool-a',
      name: 'Agent',
      status: 'completed',
      startedAt: 1000,
      updatedAt: 2000,
      sortOrder: 1,
      snapshotJson: '{"private":"team"}'
    }
    expect(
      (
        await client.request('db/sub-agent-history-apply', {
          ...item,
          workspaceId: 'local-personal'
        })
      ).success
    ).toBe(false)
    expect(
      (await client.request('db/sub-agent-history-apply', { ...item, workspaceId: 'team-a' }))
        .success
    ).toBe(true)
    await expect(
      client.request('db/sub-agent-history-list', {
        dbPath,
        sessionId: 'team-session',
        workspaceId: 'local-personal'
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('another workspace') })
    await expect(
      client.request('db/sub-agent-history-index', {
        dbPath,
        sessionId: 'team-session',
        workspaceId: 'local-personal'
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('another workspace') })
    const page = await client.request('db/sub-agent-history-list', {
      dbPath,
      sessionId: 'team-session',
      workspaceId: 'team-a'
    })
    expect(page.items).toEqual([expect.objectContaining({ snapshotJson: '{"private":"team"}' })])
    expect(
      (
        await client.request('db/sub-agent-history-replace', {
          dbPath,
          sessionId: 'team-session',
          workspaceId: 'local-personal',
          items: []
        })
      ).success
    ).toBe(false)
    expect(
      (
        await client.request('db/sub-agent-history-list', {
          dbPath,
          sessionId: 'team-session',
          workspaceId: 'team-a'
        })
      ).items
    ).toHaveLength(1)
  }, 30_000)
})
