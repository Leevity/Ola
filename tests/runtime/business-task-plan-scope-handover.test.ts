import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { createLegacyDatabaseHandoverSnapshot } from '../../src/runtime/storage/legacy-database-handover'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('keeps Native and TS task plan links inside the task session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-task-plan-scope-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const { client, child } = await startWorker(directory)
  cleanup.push(async () => {
    client.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolveExit) => child.once('exit', resolveExit))
    }
  })
  const dbPath = join(directory, 'native.db')
  expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
  for (const [id, workspaceId] of [
    ['session-a', 'team-a'],
    ['session-b', 'team-a'],
    ['session-c', 'team-b']
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
  expect(
    (
      await client.request('db/plans-create', {
        dbPath,
        id: 'plan-b',
        sessionId: 'session-b',
        workspaceId: 'team-a',
        title: 'B plan',
        createdAt: 1,
        updatedAt: 1
      })
    ).success
  ).toBe(true)
  expect(
    (
      await client.request('db/plans-create', {
        dbPath,
        id: 'plan-b-latest',
        sessionId: 'session-b',
        workspaceId: 'team-a',
        title: 'Latest B plan',
        createdAt: 2,
        updatedAt: 2
      })
    ).success
  ).toBe(true)
  const nativeLatestPlan = await client.request('db/plans-get-by-session', {
    dbPath,
    sessionId: 'session-b',
    workspaceId: 'team-a'
  })
  expect(nativeLatestPlan.plan.id).toBe('plan-b-latest')
  expect(
    (
      await client.request('db/plans-get-by-session', {
        dbPath,
        sessionId: 'session-b',
        workspaceId: 'team-b'
      })
    ).plan
  ).toBeUndefined()
  for (const [sessionId, workspaceId] of [
    ['session-a', 'team-a'],
    ['session-c', 'team-b']
  ]) {
    expect(
      (
        await client.request('db/tasks-create', {
          dbPath,
          id: `rejected-${sessionId}`,
          sessionId,
          workspaceId,
          planId: 'plan-b',
          subject: 'Rejected'
        })
      ).success
    ).toBe(false)
  }
  expect(
    (
      await client.request('db/tasks-create', {
        dbPath,
        id: 'native-task-b',
        sessionId: 'session-b',
        workspaceId: 'team-a',
        planId: 'plan-b',
        subject: 'Allowed'
      })
    ).success
  ).toBe(true)
  const nativeSessionStatus = await client.request('db/session-status', {
    dbPath,
    sessionId: 'session-b',
    workspaceId: 'team-a'
  })
  expect(nativeSessionStatus).toMatchObject({ success: true, found: true, messageCount: 0 })

  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backups')
  })
  const repository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => repository.close())
  await expect(
    repository.sessionStatus({ sessionId: 'session-b', workspaceId: 'team-a' })
  ).resolves.toEqual(nativeSessionStatus)
  await expect(
    repository.sessionStatus({ sessionId: 'session-b', workspaceId: 'team-b' })
  ).resolves.toEqual(
    await client.request('db/session-status', {
      dbPath,
      sessionId: 'session-b',
      workspaceId: 'team-b'
    })
  )
  await expect(repository.planBySession('session-b', 'team-a')).resolves.toEqual(
    nativeLatestPlan.plan
  )
  await expect(repository.planBySession('session-b', 'team-b')).resolves.toBeNull()
  const nativePlan = await client.request('db/plans-get', {
    dbPath,
    id: 'plan-b',
    workspaceId: 'team-a'
  })
  await expect(repository.plan('plan-b', 'team-a')).resolves.toEqual(nativePlan.plan)
  await expect(repository.plans('team-a')).resolves.toEqual(
    await client.request('db/plans-list', { dbPath, workspaceId: 'team-a' })
  )
  expect((await repository.task<{ plan_id: string }>('native-task-b', 'team-a'))?.plan_id).toBe(
    'plan-b'
  )
  const taskInput = {
    id: 'ts-task-a',
    sessionId: 'session-a',
    workspaceId: 'team-a',
    subject: 'A task',
    description: 'Task description',
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1
  }
  await expect(repository.createTask({ ...taskInput, planId: 'plan-b' })).rejects.toThrow(
    'BUSINESS_PLAN_NOT_FOUND'
  )
  expect(await repository.createTask(taskInput)).toBe(true)
  await expect(
    repository.updateTask({ id: taskInput.id, workspaceId: 'team-a', planId: 'plan-b' })
  ).rejects.toThrow('BUSINESS_PLAN_NOT_FOUND')
  expect(
    (await repository.task<{ plan_id: string | null }>(taskInput.id, 'team-a'))?.plan_id
  ).toBeNull()
  expect(
    await repository.createTask({
      ...taskInput,
      id: 'ts-task-b',
      sessionId: 'session-b',
      planId: 'plan-b'
    })
  ).toBe(true)
})
