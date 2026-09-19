import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import {
  canaryIndexSubAgentHistory,
  canaryListSubAgentHistory,
  closeLegacyReadCanary
} from '../../src/main/db/legacy-read-canary'
import type {
  SubAgentHistoryPage,
  SubAgentHistoryRow
} from '../../src/shared/sub-agent-history-types'

const cleanup: Array<() => Promise<void>> = []
const originalPath = process.env.OLA_TS_LEGACY_READ_PATH
const originalEnabled = process.env.OLA_TS_SUB_AGENT_HISTORY_READS

afterEach(async () => {
  await closeLegacyReadCanary()
  if (originalPath === undefined) delete process.env.OLA_TS_LEGACY_READ_PATH
  else process.env.OLA_TS_LEGACY_READ_PATH = originalPath
  if (originalEnabled === undefined) delete process.env.OLA_TS_SUB_AGENT_HISTORY_READS
  else process.env.OLA_TS_SUB_AGENT_HISTORY_READS = originalEnabled
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('matches Native sub-agent index and pages on a real workspace-scoped database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-sub-agent-read-parity-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const { client, child } = await startWorker(directory)
  cleanup.push(async () => {
    client.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
  const dbPath = join(directory, 'data.db')
  expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
  for (const [sessionId, workspaceId] of [
    ['personal-session', 'local-personal'],
    ['team-session', 'team-a'],
    ['foreign-session', 'team-b']
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
    for (let n = 1; n <= 3; n++) {
      expect(
        (
          await client.request('db/sub-agent-history-apply', {
            dbPath,
            workspaceId,
            sessionId,
            id: `${sessionId}-${n}`,
            subAgentId: `agent-${n}`,
            toolUseId: `tool-${n}`,
            name: `Agent ${n}`,
            status: 'completed',
            startedAt: n,
            completedAt: n + 1,
            updatedAt: n + 1,
            sortOrder: n,
            snapshotJson: JSON.stringify({ sessionId, n })
          })
        ).success
      ).toBe(true)
    }
  }
  const reader = new LegacyReadRepository(dbPath)
  cleanup.push(() => reader.close())
  for (const [sessionId, workspaceId] of [
    ['personal-session', 'local-personal'],
    ['team-session', 'team-a'],
    ['foreign-session', 'team-b']
  ]) {
    expect(
      await reader.subAgentHistoryIndex<SubAgentHistoryRow>(sessionId, workspaceId, 2)
    ).toEqual(
      await client.request('db/sub-agent-history-index', {
        dbPath,
        sessionId,
        workspaceId,
        limit: 2
      })
    )
    for (const pageOffset of [0, 2, 4]) {
      expect(
        await reader.subAgentHistoryPage<SubAgentHistoryPage>({
          sessionId,
          workspaceId,
          limit: 2,
          offset: pageOffset
        })
      ).toEqual(
        await client.request('db/sub-agent-history-list', {
          dbPath,
          sessionId,
          workspaceId,
          limit: 2,
          offset: pageOffset
        })
      )
    }
  }
  await expect(reader.subAgentHistoryIndex('team-session', 'local-personal', 2)).rejects.toThrow(
    'SUB_AGENT_HISTORY_SESSION_WORKSPACE_MISMATCH'
  )
  await expect(
    reader.subAgentHistoryPage({
      sessionId: 'missing',
      workspaceId: 'team-a',
      limit: 2,
      offset: 0
    })
  ).rejects.toThrow('SUB_AGENT_HISTORY_SESSION_WORKSPACE_MISMATCH')

  process.env.OLA_TS_LEGACY_READ_PATH = dbPath
  delete process.env.OLA_TS_SUB_AGENT_HISTORY_READS
  expect(await canaryIndexSubAgentHistory('team-session', 'team-a', 2)).toEqual(
    await client.request('db/sub-agent-history-index', {
      dbPath,
      sessionId: 'team-session',
      workspaceId: 'team-a',
      limit: 2
    })
  )
  expect(
    await canaryListSubAgentHistory({
      sessionId: 'team-session',
      workspaceId: 'team-a',
      limit: 2,
      offset: 0
    })
  ).toEqual(
    await client.request('db/sub-agent-history-list', {
      dbPath,
      sessionId: 'team-session',
      workspaceId: 'team-a',
      limit: 2,
      offset: 0
    })
  )
  process.env.OLA_TS_SUB_AGENT_HISTORY_READS = '0'
  expect(await canaryIndexSubAgentHistory('team-session', 'team-a', 2)).toBeUndefined()
  expect(
    await canaryListSubAgentHistory({
      sessionId: 'team-session',
      workspaceId: 'team-a',
      limit: 2,
      offset: 0
    })
  ).toBeUndefined()
})
