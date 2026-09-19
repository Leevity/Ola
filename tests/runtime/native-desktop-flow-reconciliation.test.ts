import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import {
  reconcileDesktopFlows,
  type DesktopFlowReconciliationPorts
} from '../../src/main/desktop/desktop-flow-reconciliation'
import type { DesktopFlow, DesktopFlowRun } from '../../src/shared/desktop-flow'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('reconciles offline team flows and run history into the real Native database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-native-flow-reconcile-'))
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
  const flow = (id: string, updatedAt: number): DesktopFlow => ({
    id,
    workspaceId: 'team-a',
    name: id,
    createdAt: 1,
    updatedAt,
    steps: []
  })
  for (const item of [flow('flow-old', 1), flow('flow-deleted', 1)]) {
    expect(
      await client.request('db/desktop-flow-save', {
        dbPath,
        id: item.id,
        name: item.name,
        flowJson: JSON.stringify(item),
        workspaceId: 'team-a'
      })
    ).toMatchObject({ success: true })
  }
  const offlineRun: DesktopFlowRun = {
    id: 'run-offline',
    flowId: 'flow-new',
    state: 'succeeded',
    errorMessage: null,
    startedAt: 7,
    finishedAt: 8
  }
  const readFlows = async (workspaceId: string) =>
    ((await client.request('db/desktop-flows-list', { dbPath, workspaceId })) as string[]).map(
      (row) => JSON.parse(row) as DesktopFlow
    )
  const readRuns = async (workspaceId: string) =>
    (
      (await client.request('db/desktop-flow-runs-list', {
        dbPath,
        workspaceId,
        limit: 10_000
      })) as string[]
    ).map((row) => JSON.parse(row) as DesktopFlowRun)
  const ports: DesktopFlowReconciliationPorts = {
    authorize: async () => undefined,
    listNativeFlows: () => readFlows('team-a'),
    saveNativeFlow: async (item) => {
      const result = await client.request('db/desktop-flow-save', {
        dbPath,
        id: item.id,
        name: item.name,
        flowJson: JSON.stringify(item),
        createdAt: item.createdAt,
        workspaceId: 'team-a'
      })
      if (!result.success) throw new Error(result.error)
    },
    deleteNativeFlow: async (id) => {
      const result = await client.request('db/desktop-flow-delete', {
        dbPath,
        id,
        workspaceId: 'team-a'
      })
      if (!result.success) throw new Error(result.error)
      return result.changed > 0
    },
    listNativeRuns: () => readRuns('team-a'),
    startNativeRun: async (run) => {
      const result = await client.request('db/desktop-flow-run-start', {
        dbPath,
        id: run.id,
        flowId: run.flowId,
        workspaceId: 'team-a',
        startedAt: run.startedAt
      })
      if (!result.success) throw new Error(result.error)
    },
    finishNativeRun: async (run) => {
      const result = await client.request('db/desktop-flow-run-finish', {
        dbPath,
        id: run.id,
        workspaceId: 'team-a',
        state: run.state,
        finishedAt: run.finishedAt
      })
      if (!result.success) throw new Error(result.error)
      return result.changed > 0
    },
    listLocalFlows: () => [flow('flow-old', 5), flow('flow-new', 6)],
    listLocalDeletions: () => ['flow-deleted'],
    listLocalRuns: () => [offlineRun]
  }
  await expect(reconcileDesktopFlows(ports)).resolves.toEqual({
    savedFlows: 2,
    deletedFlows: 1,
    savedRuns: 1,
    failed: 0
  })
  expect((await readFlows('team-a')).map((item) => item.id).sort()).toEqual([
    'flow-new',
    'flow-old'
  ])
  expect(await readFlows('team-b')).toEqual([])
  expect(await readRuns('team-a')).toMatchObject([offlineRun])
  await expect(reconcileDesktopFlows(ports)).resolves.toEqual({
    savedFlows: 0,
    deletedFlows: 0,
    savedRuns: 0,
    failed: 0
  })
})
