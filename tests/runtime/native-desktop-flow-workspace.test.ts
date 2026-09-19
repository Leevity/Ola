import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import {
  canaryListDesktopFlowRuns,
  closeLegacyReadCanary
} from '../../src/main/db/legacy-read-canary'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('backfills old desktop flows to personal and isolates Native mutations by workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-native-flow-workspace-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const dbPath = join(directory, 'native.db')
  const old = new DatabaseSync(dbPath)
  old.exec(`
    CREATE TABLE desktop_flows (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, flow_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO desktop_flows VALUES(
      'legacy-flow','Legacy',
      '{"id":"legacy-flow","name":"Legacy","createdAt":1,"updatedAt":1,"steps":[]}',1,1
    );
  `)
  old.close()
  const { client, child } = await startWorker(directory)
  cleanup.push(async () => {
    client.close()
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
  expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
  const list = async (workspaceId: string) =>
    (await client.request('db/desktop-flows-list', { dbPath, workspaceId })) as string[]
  expect((await list('local-personal')).map((row) => JSON.parse(row).id)).toEqual(['legacy-flow'])
  expect(await list('team-a')).toEqual([])
  const teamFlow = {
    id: 'team-flow',
    name: 'Team',
    createdAt: 2,
    updatedAt: 2,
    workspaceId: 'team-a',
    steps: [{ id: 'step-a', type: 'wait', riskLevel: 'low' }]
  }
  expect(
    await client.request('db/desktop-flow-save', {
      dbPath,
      id: teamFlow.id,
      name: teamFlow.name,
      flowJson: JSON.stringify(teamFlow),
      createdAt: teamFlow.createdAt,
      workspaceId: 'team-a'
    })
  ).toMatchObject({ success: true, changed: 1 })
  expect((await list('team-a')).map((row) => JSON.parse(row).id)).toEqual(['team-flow'])
  expect((await list('local-personal')).map((row) => JSON.parse(row).id)).toEqual(['legacy-flow'])
  expect(
    await client.request('db/desktop-flow-run-start', {
      dbPath,
      id: 'run-a',
      flowId: teamFlow.id,
      workspaceId: 'local-personal',
      startedAt: 3
    })
  ).toMatchObject({ success: false })
  expect(
    await client.request('db/desktop-flow-run-start', {
      dbPath,
      id: 'run-a',
      flowId: teamFlow.id,
      workspaceId: 'team-a',
      startedAt: 3
    })
  ).toMatchObject({ success: true, changed: 1 })
  expect(
    await client.request('db/desktop-flow-run-finish', {
      dbPath,
      id: 'run-a',
      workspaceId: 'local-personal',
      state: 'succeeded',
      finishedAt: 4
    })
  ).toMatchObject({ success: true, changed: 0 })
  expect(
    await client.request('db/desktop-flow-run-finish', {
      dbPath,
      id: 'run-a',
      workspaceId: 'team-a',
      state: 'succeeded',
      finishedAt: 4
    })
  ).toMatchObject({ success: true, changed: 1 })
  expect(
    await client.request('db/desktop-flow-runs-list', { dbPath, workspaceId: 'team-a' })
  ).toEqual([
    JSON.stringify({
      id: 'run-a',
      flowId: teamFlow.id,
      state: 'succeeded',
      errorMessage: null,
      startedAt: 3,
      finishedAt: 4
    })
  ])
  expect(
    await client.request('db/desktop-flow-runs-list', { dbPath, workspaceId: 'local-personal' })
  ).toEqual([])
  const reader = new LegacyReadRepository(dbPath)
  cleanup.push(() => reader.close())
  for (const workspaceId of ['team-a', 'local-personal']) {
    expect(await reader.desktopFlowRuns(workspaceId, 1)).toEqual(
      await client.request('db/desktop-flow-runs-list', { dbPath, workspaceId, limit: 1 })
    )
  }
  const originalPath = process.env.OLA_TS_LEGACY_READ_PATH
  const originalEnabled = process.env.OLA_TS_DESKTOP_FLOW_RUN_READS
  try {
    process.env.OLA_TS_LEGACY_READ_PATH = dbPath
    delete process.env.OLA_TS_DESKTOP_FLOW_RUN_READS
    expect(await canaryListDesktopFlowRuns('team-a')).toEqual(
      await client.request('db/desktop-flow-runs-list', { dbPath, workspaceId: 'team-a' })
    )
    process.env.OLA_TS_DESKTOP_FLOW_RUN_READS = '0'
    expect(await canaryListDesktopFlowRuns('team-a')).toBeUndefined()
  } finally {
    await closeLegacyReadCanary()
    if (originalPath === undefined) delete process.env.OLA_TS_LEGACY_READ_PATH
    else process.env.OLA_TS_LEGACY_READ_PATH = originalPath
    if (originalEnabled === undefined) delete process.env.OLA_TS_DESKTOP_FLOW_RUN_READS
    else process.env.OLA_TS_DESKTOP_FLOW_RUN_READS = originalEnabled
  }
  expect(
    await client.request('db/desktop-flow-save', {
      dbPath,
      id: teamFlow.id,
      name: 'Forged',
      flowJson: JSON.stringify({ ...teamFlow, workspaceId: 'local-personal' }),
      workspaceId: 'local-personal'
    })
  ).toMatchObject({ success: false })
  expect(
    await client.request('db/desktop-flow-delete', {
      dbPath,
      id: teamFlow.id,
      workspaceId: 'local-personal'
    })
  ).toMatchObject({ success: true, changed: 0 })
  expect((await list('team-a')).map((row) => JSON.parse(row).id)).toEqual(['team-flow'])
  expect(
    await client.request('db/desktop-flow-delete', {
      dbPath,
      id: teamFlow.id,
      workspaceId: 'team-a'
    })
  ).toMatchObject({ success: true, changed: 1 })
  expect(await list('team-a')).toEqual([])
})
