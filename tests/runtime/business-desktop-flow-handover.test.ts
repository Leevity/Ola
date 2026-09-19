import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { createLegacyDatabaseHandoverSnapshot } from '../../src/runtime/storage/legacy-database-handover'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import type { DesktopFlow } from '../../src/shared/desktop-flow'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('continues Native desktop flows on a TS handover copy without crossing workspaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-ts-desktop-flow-handover-'))
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
  const local: DesktopFlow = {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'local-personal',
    name: 'Personal flow',
    createdAt: 1,
    updatedAt: 1,
    steps: [{ id: 'local-step', type: 'wait', createdAt: 1, riskLevel: 'low' }]
  }
  const team: DesktopFlow = {
    id: '22222222-2222-4222-8222-222222222222',
    workspaceId: 'team-a',
    name: 'Team flow',
    createdAt: 2,
    updatedAt: 2,
    steps: [{ id: 'team-step', type: 'wait', createdAt: 2, riskLevel: 'low' }]
  }
  for (const flow of [local, team]) {
    const result = await client.request('db/desktop-flow-save', {
      dbPath,
      id: flow.id,
      name: flow.name,
      flowJson: JSON.stringify(flow),
      createdAt: flow.createdAt,
      workspaceId: flow.workspaceId
    })
    expect(result.success).toBe(true)
  }
  expect(
    await client.request('db/desktop-flow-run-start', {
      dbPath,
      id: 'native-run-a',
      flowId: team.id,
      workspaceId: 'team-a',
      startedAt: 3
    })
  ).toMatchObject({ success: true })
  expect(
    await client.request('db/desktop-flow-run-finish', {
      dbPath,
      id: 'native-run-a',
      workspaceId: 'team-a',
      state: 'succeeded',
      finishedAt: 4
    })
  ).toMatchObject({ success: true })
  const liveReader = new LegacyReadRepository(dbPath)
  cleanup.push(() => liveReader.close())
  for (const workspaceId of ['local-personal', 'team-a', 'team-b']) {
    const nativeRows = (await client.request('db/desktop-flows-list', {
      dbPath,
      workspaceId
    })) as string[]
    await expect(liveReader.desktopFlows(workspaceId)).resolves.toEqual(nativeRows)
  }
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backups')
  })
  const repository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => repository.close())

  expect((await repository.desktopFlows('local-personal')).map((flow) => flow.id)).toEqual([
    local.id
  ])
  expect((await repository.desktopFlows('team-a')).map((flow) => flow.id)).toEqual([team.id])
  await expect(repository.desktopFlows('team-b')).resolves.toEqual([])
  await expect(repository.desktopFlowRuns('team-a')).resolves.toEqual([
    {
      id: 'native-run-a',
      flowId: team.id,
      state: 'succeeded',
      errorMessage: null,
      startedAt: 3,
      finishedAt: 4
    }
  ])
  await expect(repository.desktopFlowRuns('team-b')).resolves.toEqual([])
  await expect(repository.startDesktopFlowRun('forged-run', team.id, 'team-b', 5)).rejects.toThrow(
    'BUSINESS_DESKTOP_FLOW_WORKSPACE_MISMATCH'
  )
  await expect(repository.startDesktopFlowRun('ts-run-a', team.id, 'team-a', 5)).resolves.toBe(true)
  await expect(repository.finishDesktopFlowRun('ts-run-a', 'team-b', 'failed', 6)).resolves.toBe(
    false
  )
  await expect(repository.finishDesktopFlowRun('ts-run-a', 'team-a', 'cancelled', 6)).resolves.toBe(
    true
  )
  expect((await repository.desktopFlowRuns('team-a')).map((run) => run.state)).toEqual([
    'cancelled',
    'succeeded'
  ])
  await expect(
    repository.saveDesktopFlow({ ...team, workspaceId: 'team-b' }, 'team-b')
  ).rejects.toThrow('BUSINESS_DESKTOP_FLOW_WORKSPACE_MISMATCH')
  await expect(repository.deleteDesktopFlow(team.id, 'team-b')).resolves.toBe(false)

  const updated: DesktopFlow = {
    ...team,
    name: 'Updated team flow',
    updatedAt: 5,
    steps: [{ id: 'new-step', type: 'wait', createdAt: 5, riskLevel: 'low' }]
  }
  await expect(repository.saveDesktopFlow(updated, 'team-a')).resolves.toBe(true)
  await expect(repository.desktopFlows('team-a')).resolves.toEqual([updated])
  const copy = new DatabaseSync(snapshot.backupPath)
  expect(
    copy.prepare('SELECT step_id FROM desktop_flow_steps WHERE flow_id=?').all(team.id)
  ).toEqual([{ step_id: 'new-step' }])
  copy.close()
  await repository.saveDesktopFlow(
    {
      ...updated,
      steps: [
        { id: 'typed-step', type: 'type', text: 'private input', createdAt: 6, riskLevel: 'high' }
      ]
    },
    'team-a'
  )
  const redacted = (await repository.desktopFlows('team-a'))[0]
  expect(redacted.requiresReview).toBe(true)
  expect(redacted.steps[0].text).toBeUndefined()
  await expect(repository.deleteDesktopFlow(team.id, 'team-a')).resolves.toBe(true)
  await expect(repository.desktopFlows('team-a')).resolves.toEqual([])
  await expect(repository.desktopFlowRuns('team-a')).resolves.toEqual([])
  expect((await repository.desktopFlows('local-personal')).map((flow) => flow.id)).toEqual([
    local.id
  ])
})
