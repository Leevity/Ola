import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { createLegacyDatabaseHandoverSnapshot } from '../../src/runtime/storage/legacy-database-handover'
import * as goalsDao from '../../src/main/db/goals-dao'
import * as messagesDao from '../../src/main/db/messages-dao'
import * as projectsDao from '../../src/main/db/projects-dao'
import * as plansDao from '../../src/main/db/plans-dao'
import * as sessionsDao from '../../src/main/db/sessions-dao'
import * as tasksDao from '../../src/main/db/tasks-dao'
import * as drawRunsDao from '../../src/main/db/draw-runs-dao'
import * as usageEventsDao from '../../src/main/db/usage-events-dao'
import * as agentChangesDao from '../../src/main/db/agent-changes-dao'
import * as subAgentHistoryDao from '../../src/main/db/sub-agent-history-dao'
import * as memoryAutomationDao from '../../src/main/db/memory-automation-dao'
import * as cronDao from '../../src/main/db/cron-dao'
import * as capabilityDao from '../../src/main/db/capability-dao'
import * as memoryPipelineDao from '../../src/main/db/memory-pipeline-dao'
import { closeBusinessWriteCanary } from '../../src/main/db/business-write-canary'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

const cleanup: Array<() => Promise<void>> = []
const previousEnvironment = new Map<string, string | undefined>()
const canaryEnvironment = [
  'OLA_TS_BUSINESS_WRITES',
  'OLA_TS_BUSINESS_WRITE_PATH',
  'OLA_TS_BUSINESS_WRITE_MANIFEST'
]

afterEach(async () => {
  await closeBusinessWriteCanary()
  for (const key of canaryEnvironment) {
    const value = previousEnvironment.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  previousEnvironment.clear()
  for (const close of cleanup.splice(0).reverse()) await close()
})

function enableCanary(path: string, manifestPath: string): void {
  for (const key of canaryEnvironment) previousEnvironment.set(key, process.env[key])
  process.env.OLA_TS_BUSINESS_WRITES = '1'
  process.env.OLA_TS_BUSINESS_WRITE_PATH = path
  process.env.OLA_TS_BUSINESS_WRITE_MANIFEST = manifestPath
}

it('routes Goal mutations to a verified TS handover copy without Native fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-business-write-canary-'))
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
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'goal-session',
        title: 'Goal session',
        mode: 'chat',
        workspaceId: 'team-a',
        createdAt: 1,
        updatedAt: 1
      })
    ).success
  ).toBe(true)
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  const created = await goalsDao.createGoal({
    sessionId: 'goal-session',
    workspaceId: 'team-a',
    objective: 'TS-owned goal',
    tokenBudget: 10
  })
  expect(created).toMatchObject({ objective: 'TS-owned goal', status: 'active' })
  const accounted = await goalsDao.accountGoalUsage({
    sessionId: 'goal-session',
    workspaceId: 'team-a',
    timeDeltaSeconds: 2,
    tokenDelta: 3,
    expectedGoalId: created?.goal_id
  })
  expect(accounted).toMatchObject({ tokens_used: 3, time_used_seconds: 2 })
  expect(await goalsDao.clearGoal('goal-session', 'team-a')).toBe(true)

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(tsRepository.goal('goal-session', 'team-a')).resolves.toBeNull()
  await expect(tsRepository.goalEvents('goal-session', 'team-a')).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event_type: 'created' }),
      expect.objectContaining({ event_type: 'usage_accounted' }),
      expect.objectContaining({ event_type: 'cleared' })
    ])
  )
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM session_goals').get()).toEqual({
    count: 0
  })
  nativeSource.close()
})

it('refuses partial canary configuration instead of silently using Native', async () => {
  for (const key of canaryEnvironment) previousEnvironment.set(key, process.env[key])
  process.env.OLA_TS_BUSINESS_WRITES = '1'
  delete process.env.OLA_TS_BUSINESS_WRITE_PATH
  delete process.env.OLA_TS_BUSINESS_WRITE_MANIFEST
  await expect(goalsDao.clearGoal('missing-session', 'team-a')).rejects.toThrow(
    'TS_BUSINESS_WRITE_HANDOVER_REQUIRED'
  )
})

it('routes ordinary session mutations to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-session-write-canary-'))
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
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'native-session',
        title: 'Native session',
        mode: 'chat',
        workspaceId: 'team-a',
        createdAt: 1,
        updatedAt: 1
      })
    ).success
  ).toBe(true)
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  await sessionsDao.createSession({
    id: 'ts-session',
    title: 'TS session',
    mode: 'chat',
    createdAt: 10,
    updatedAt: 10,
    workspaceId: 'team-a'
  })
  await sessionsDao.updateSession('ts-session', 'team-a', { title: 'TS updated' })
  await expect(sessionsDao.deleteSession('ts-session', 'team-b')).rejects.toThrow(
    'BUSINESS_SESSION_NOT_FOUND'
  )
  await sessionsDao.createSession({
    id: 'ts-session-two',
    title: 'TS session two',
    mode: 'chat',
    createdAt: 11,
    updatedAt: 11,
    workspaceId: 'team-a'
  })
  const cleared = await sessionsDao.clearAllSessions('team-a')
  expect(cleared).toMatchObject({ success: true, deletedSessions: 3 })

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(tsRepository.session('ts-session', 'team-a')).resolves.toBeNull()
  await expect(tsRepository.session('native-session', 'team-a')).resolves.toBeNull()
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 })
  nativeSource.close()
})

it('routes project mutations to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-project-write-canary-'))
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
  expect(
    await client.request('db/projects-create', {
      dbPath,
      id: 'native-project',
      name: 'Native project',
      workspaceId: 'team-a',
      createdAt: 1,
      updatedAt: 1
    })
  ).toMatchObject({ id: 'native-project' })
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  const created = await projectsDao.createProject({
    id: 'ts-project',
    name: 'TS project',
    workingFolder: join(directory, 'project'),
    workspaceId: 'team-a',
    createdAt: 10,
    updatedAt: 10
  })
  expect(created).toMatchObject({ id: 'ts-project', name: 'TS project', workspace_id: 'team-a' })
  await projectsDao.updateProject('ts-project', 'team-a', { name: 'TS updated' })
  await expect(projectsDao.deleteProject('ts-project', 'team-b')).rejects.toThrow(
    'BUSINESS_PROJECT_NOT_FOUND'
  )
  const deleted = await projectsDao.deleteProject('ts-project', 'team-a')
  expect(deleted).toMatchObject({ success: true, deleted: true, projectId: 'ts-project' })

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(tsRepository.project('ts-project', 'team-a')).resolves.toBeNull()
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 1 })
  nativeSource.close()
})

it('routes plan mutations to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-plan-write-canary-'))
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
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'plan-session',
        title: 'Plan session',
        mode: 'chat',
        workspaceId: 'team-a',
        createdAt: 1,
        updatedAt: 1
      })
    ).success
  ).toBe(true)
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  await plansDao.createPlan({
    id: 'ts-plan',
    sessionId: 'plan-session',
    title: 'TS plan',
    status: 'drafting',
    content: 'initial',
    specJson: JSON.stringify({ steps: ['one'] }),
    workspaceId: 'team-a',
    createdAt: 10,
    updatedAt: 10
  })
  await plansDao.updatePlan('ts-plan', 'team-a', {
    title: 'TS updated',
    specJson: JSON.stringify({ steps: ['one', 'two'] })
  })
  await expect(plansDao.updatePlan('ts-plan', 'team-b', { title: 'wrong' })).rejects.toThrow(
    'BUSINESS_PLAN_NOT_FOUND'
  )
  await plansDao.deletePlan('ts-plan', 'team-a')

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(tsRepository.plan('ts-plan', 'team-a')).resolves.toBeNull()
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM plans').get()).toEqual({ count: 0 })
  nativeSource.close()
})

it('routes task mutations to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-task-write-canary-'))
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
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'task-session',
        title: 'Task session',
        mode: 'chat',
        workspaceId: 'team-a',
        createdAt: 1,
        updatedAt: 1
      })
    ).success
  ).toBe(true)
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  await tasksDao.createTask({
    id: 'ts-task',
    sessionId: 'task-session',
    workspaceId: 'team-a',
    subject: 'TS task',
    description: 'initial',
    blocks: ['next'],
    metadata: { source: 'test' },
    sortOrder: 1,
    createdAt: 10,
    updatedAt: 10
  })
  await tasksDao.updateTask('ts-task', 'team-a', { status: 'in_progress', description: 'updated' })
  await expect(tasksDao.deleteTask('ts-task', 'team-b')).rejects.toThrow('BUSINESS_TASK_NOT_FOUND')
  await tasksDao.deleteTasksBySession('task-session', 'team-a')

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(tsRepository.task('ts-task', 'team-a')).resolves.toBeNull()
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
  nativeSource.close()
})

it('routes message lifecycle mutations to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-message-write-canary-'))
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
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'message-session',
        title: 'Message session',
        mode: 'chat',
        workspaceId: 'team-a',
        createdAt: 1,
        updatedAt: 1
      })
    ).success
  ).toBe(true)
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  await messagesDao.addMessage({
    id: 'message-one',
    sessionId: 'message-session',
    workspaceId: 'team-a',
    role: 'user',
    content: 'one',
    createdAt: 10,
    sortOrder: 1
  })
  await messagesDao.addMessages([
    {
      id: 'message-two',
      sessionId: 'message-session',
      workspaceId: 'team-a',
      role: 'assistant',
      content: 'two',
      createdAt: 11,
      sortOrder: 2
    },
    {
      id: 'message-three',
      sessionId: 'message-session',
      workspaceId: 'team-a',
      role: 'assistant',
      content: 'three',
      createdAt: 12,
      sortOrder: 3
    }
  ])
  await messagesDao.updateMessage('message-one', { content: 'updated' }, 'team-a')
  await messagesDao.replaceMessages(
    'message-session',
    [
      { id: 'message-four', role: 'user', content: 'four', createdAt: 20, sortOrder: 1 },
      { id: 'message-five', role: 'assistant', content: 'five', createdAt: 21, sortOrder: 2 }
    ],
    'team-a'
  )
  await expect(
    messagesDao.deleteMessage('message-session', 'message-four', 'team-b')
  ).rejects.toThrow('BUSINESS_SESSION_NOT_FOUND')
  await expect(
    messagesDao.deleteLastMessage('message-session', 'assistant', 'team-a')
  ).resolves.toMatchObject({
    id: 'message-five'
  })
  await messagesDao.upsertMessage({
    id: 'message-six',
    sessionId: 'message-session',
    workspaceId: 'team-a',
    role: 'assistant',
    content: 'six',
    createdAt: 22,
    sortOrder: 2
  })
  await messagesDao.truncateMessagesFrom('message-session', 2, 'team-a')
  await messagesDao.clearMessages('message-session', 'team-a')

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(tsRepository.messages('message-session', 'team-a')).resolves.toEqual([])
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
  nativeSource.close()
})

it('routes draw-run mutations to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-draw-write-canary-'))
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
  expect(
    await client.request('db/draw-runs-save', {
      dbPath,
      id: 'native-draw',
      workspaceId: 'local-personal',
      prompt: 'native',
      providerName: 'Provider',
      modelName: 'Model',
      createdAt: 1,
      updatedAt: 1,
      isGenerating: false,
      imagesJson: '[]'
    })
  ).toMatchObject({ success: true })
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  await drawRunsDao.saveDrawRun({
    id: 'ts-draw',
    workspaceId: 'local-personal',
    prompt: 'ts',
    providerName: 'Provider',
    modelName: 'Model',
    createdAt: 10,
    isGenerating: false,
    imagesJson: '[]',
    updatedAt: 10
  })
  await expect(drawRunsDao.deleteDrawRun('ts-draw', 'team-b')).rejects.toThrow(
    'Draw workspace is not available'
  )
  await drawRunsDao.clearDrawRuns('local-personal')

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(tsRepository.drawRuns('local-personal')).resolves.toEqual([])
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM draw_runs').get()).toEqual({
    count: 1
  })
  nativeSource.close()
})

it('routes usage event writes and deletes to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-usage-write-canary-'))
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
  expect(
    await client.request('db/usage-add-event', {
      dbPath,
      id: 'native-usage',
      workspace_id: 'local-personal',
      created_at: 1,
      source_kind: 'test',
      input_tokens: 1,
      output_tokens: 1
    })
  ).toMatchObject({ success: true })
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  await usageEventsDao.addUsageEvent({
    id: 'ts-usage',
    workspace_id: 'local-personal',
    source_kind: 'test',
    input_tokens: 2,
    output_tokens: 3
  } as Parameters<typeof usageEventsDao.addUsageEvent>[0])
  expect(
    await usageEventsDao.deleteUsageEvents({
      workspaceId: 'local-personal',
      from: 0,
      to: Date.now() + 1000
    })
  ).toEqual({ deleted: 2 })

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(
    tsRepository.usageEvents({ workspaceId: 'local-personal', from: 0, to: Date.now() + 1000 })
  ).resolves.toEqual([])
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM usage_events').get()).toEqual({
    count: 1
  })
  nativeSource.close()
})

it('routes agent change mutations to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-agent-change-write-canary-'))
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
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'change-session',
        title: 'Change session',
        mode: 'chat',
        workspaceId: 'team-a',
        createdAt: 1,
        updatedAt: 1
      })
    ).success
  ).toBe(true)
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  await agentChangesDao.appendStoredFileChange({
    runId: 'run-one',
    workspaceId: 'team-a',
    sessionId: 'change-session',
    assistantMessageId: 'assistant-one',
    now: 10,
    change: {
      id: 'change-one',
      runId: 'run-one',
      sessionId: 'change-session',
      assistantMessageId: 'assistant-one',
      filePath: 'src/example.ts',
      transport: 'local',
      op: 'modify',
      status: 'open',
      before: { exists: true, hash: 'before', size: 1 },
      after: { exists: true, hash: 'after', size: 2 },
      createdAt: 10
    } as never
  })
  await agentChangesDao.markFileChangeReverted({
    runId: 'run-one',
    workspaceId: 'team-a',
    changeId: 'change-one',
    revertedAt: 20
  })
  await agentChangesDao.recomputeRunStatus('run-one', 'team-a')
  await agentChangesDao.recomputeRunStatus('run-one', 'team-b')

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(tsRepository.agentChangeSet('run-one', 'team-a')).resolves.toMatchObject({
    status: 'reverted',
    changes: [expect.objectContaining({ id: 'change-one', status: 'reverted' })]
  })
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM agent_change_sets').get()).toEqual({
    count: 0
  })
  nativeSource.close()
})

it('routes sub-agent history mutations to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-sub-agent-write-canary-'))
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
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'sub-agent-session',
        title: 'Sub agent session',
        mode: 'chat',
        workspaceId: 'team-a',
        createdAt: 1,
        updatedAt: 1
      })
    ).success
  ).toBe(true)
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  const item = {
    id: 'history-one',
    sessionId: 'sub-agent-session',
    subAgentId: 'agent-one',
    toolUseId: 'tool-one',
    name: 'Research',
    status: 'running' as const,
    startedAt: 10,
    completedAt: null,
    updatedAt: 10,
    sortOrder: 1,
    snapshotJson: '{"step":1}'
  }
  await subAgentHistoryDao.applySubAgentHistory(item, 'team-a')
  await subAgentHistoryDao.replaceSubAgentHistory({
    sessionId: 'sub-agent-session',
    workspaceId: 'team-a',
    items: [{ ...item, status: 'completed', updatedAt: 20 }]
  })
  await subAgentHistoryDao.markSubAgentHistoryMigration({ key: 'history-import', appliedAt: 30 })

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(
    tsRepository.subAgentHistoryPage({ sessionId: 'sub-agent-session', workspaceId: 'team-a' })
  ).resolves.toMatchObject({ items: [expect.objectContaining({ status: 'completed' })] })
  await expect(
    tsRepository.subAgentHistoryMigrationStatus('history-import')
  ).resolves.toMatchObject({
    applied: true,
    appliedAt: 30
  })
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM sub_agent_history').get()).toEqual({
    count: 0
  })
  nativeSource.close()
})

it('routes memory automation mutations to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-memory-write-canary-'))
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
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  const entry = await memoryAutomationDao.addMemoryAutomationEntry({
    workspaceId: 'local-personal',
    scope: 'main',
    target: 'global_memory',
    kind: 'user_preference',
    content: 'prefers concise output',
    confidence: 0.9,
    status: 'written',
    fingerprint: 'fingerprint-one',
    evidence: { source: 'test' }
  })
  expect(entry).toMatchObject({ content: 'prefers concise output', status: 'written' })
  await expect(
    memoryAutomationDao.markMemoryAutomationUndo(entry.id, 'undone', null, 'local-personal')
  ).resolves.toMatchObject({ id: entry.id, status: 'undone' })
  await memoryAutomationDao.markProcessedRollup({
    workspaceId: 'local-personal',
    scope: 'main',
    target: 'global_daily',
    targetPath: 'daily/2026-09-19',
    sourceDate: '2026-09-19',
    contentHash: 'hash-one'
  })

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(
    tsRepository.memoryAutomationEntry(entry.id, 'local-personal')
  ).resolves.toMatchObject({
    status: 'undone'
  })
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(
    nativeSource.prepare('SELECT COUNT(*) AS count FROM memory_automation_entries').get()
  ).toEqual({
    count: 0
  })
  nativeSource.close()
})

it('routes cron job mutations to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-cron-write-canary-'))
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
  const job = {
    workspace_id: 'team-a',
    id: 'cron-native',
    name: 'Native cron',
    schedule_kind: 'every' as const,
    schedule_at: null,
    schedule_every: 60_000,
    schedule_expr: null,
    schedule_tz: 'UTC',
    prompt: 'native',
    agent_id: null,
    model: null,
    model_source: null,
    working_folder: null,
    ssh_connection_id: null,
    session_id: null,
    source_session_title: null,
    source_project_id: null,
    source_project_name: null,
    source_provider_id: null,
    delivery_mode: 'none' as const,
    delivery_target: null,
    plugin_id: null,
    plugin_chat_id: null,
    enabled: 1,
    delete_after_run: 0,
    max_iterations: 10,
    deleted_at: null,
    last_fired_at: null,
    fire_count: 0,
    created_at: 1,
    updated_at: 1
  }
  expect(
    await client.request('db/cron-jobs-create', { dbPath, job, workspaceId: 'team-a' })
  ).toMatchObject({ success: true })
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  await cronDao.createCronJob({
    ...job,
    id: 'ts-cron',
    name: 'TS cron',
    created_at: 10,
    updated_at: 10
  })
  await cronDao.setCronJobEnabled('ts-cron', false, 20, 'team-a')
  await cronDao.updateCronJob(
    { ...job, id: 'ts-cron', name: 'TS updated', enabled: 0, created_at: 10, updated_at: 30 },
    'team-a'
  )
  await cronDao.createCronJob({
    ...job,
    id: 'ts-run-cron',
    name: 'Run cron',
    created_at: 10,
    updated_at: 10
  })
  await cronDao.createCronRun({
    runId: 'ts-run',
    jobId: 'ts-run-cron',
    startedAt: 50,
    workspaceId: 'team-a',
    promptSnapshot: 'run prompt'
  } as cronDao.CronRunCreateArgs & { workspaceId: string })
  await cronDao.replaceCronRunMessages(
    'ts-run',
    [{ id: 'run-message', role: 'assistant', content: 'done', createdAt: 51 }],
    'team-a'
  )
  await cronDao.appendCronRunLog('ts-run', 52, 'end', 'done', 'team-a')
  await cronDao.updateCronRun({
    runId: 'ts-run',
    workspaceId: 'team-a',
    patch: { status: 'success', finishedAt: 53, toolCallCount: 1, outputSummary: 'done' }
  } as cronDao.CronRunUpdateArgs & { workspaceId: string })
  await cronDao.softDeleteCronJob('ts-cron', 40, 'team-a')
  await cronDao.deleteCronJob('ts-cron', 'team-a')

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(tsRepository.cronJob('ts-cron', 'team-a')).resolves.toBeNull()
  await expect(tsRepository.cronRunDetail('ts-run', 'team-a')).resolves.toMatchObject({
    run: { id: 'ts-run', status: 'success' },
    messages: [expect.objectContaining({ id: 'run-message' })],
    logs: [expect.objectContaining({ content: 'done' })]
  })
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM cron_jobs').get()).toEqual({
    count: 1
  })
  nativeSource.close()
})

it('routes Wiki and desktop flow mutations to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-capability-write-canary-'))
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
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  await capabilityDao.saveWikiDocument({
    id: 'wiki-one',
    projectRoot: '/tmp/project',
    generatedAt: 10,
    fileCount: 1,
    nodes: []
  })
  await capabilityDao.deleteWikiDocument('/tmp/project')
  await capabilityDao.persistDesktopFlow({
    id: 'flow-one',
    name: 'Flow',
    createdAt: 10,
    updatedAt: 10,
    steps: []
  })
  await capabilityDao.startPersistedDesktopFlowRun('run-one', 'flow-one', 'local-personal', 20)
  await expect(
    capabilityDao.finishPersistedDesktopFlowRun('run-one', 'local-personal', 'succeeded', null, 30)
  ).resolves.toBe(true)
  await expect(capabilityDao.deletePersistedDesktopFlow('flow-one')).resolves.toBe(true)

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(tsRepository.wikiDocument('/tmp/project', 'local-personal')).resolves.toBeNull()
  await expect(tsRepository.desktopFlows('local-personal')).resolves.toEqual([])
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM wiki_documents').get()).toEqual({
    count: 0
  })
  nativeSource.close()
})

it('routes memory pipeline mutations to the verified TS handover copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-memory-pipeline-write-canary-'))
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
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'session-one',
        title: 'Memory session',
        mode: 'chat',
        workspaceId: 'local-personal',
        createdAt: 1,
        updatedAt: 1
      })
    ).success
  ).toBe(true)
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  enableCanary(snapshot.backupPath, snapshot.manifestPath)

  const root = await memoryPipelineDao.ensureMemoryRoot({
    workspaceId: 'local-personal',
    scope: 'global',
    rootPath: join(directory, 'memory'),
    transport: 'local'
  })
  const job = await memoryPipelineDao.createMemoryJob({
    workspaceId: 'local-personal',
    kind: 'stage1',
    memoryRootId: root.id,
    status: 'running'
  })
  await memoryPipelineDao.addStage1Output({
    workspaceId: 'local-personal',
    memoryRootId: root.id,
    scope: 'global',
    sourceSessionId: 'session-one',
    rawMemory: 'raw',
    rolloutSummary: 'summary',
    rolloutSlug: 'rollout',
    fingerprint: 'fingerprint'
  })
  await expect(
    memoryPipelineDao.finishMemoryJob({
      id: job.id,
      workspaceId: 'local-personal',
      status: 'succeeded'
    })
  ).resolves.toMatchObject({ status: 'succeeded' })
  await memoryPipelineDao.recordCitationUsage({
    workspaceId: 'local-personal',
    scope: 'global',
    memoryRootId: root.id,
    path: 'memory.md'
  })
  await memoryPipelineDao.clearMemoryRoot({
    memoryRootId: root.id,
    workspaceId: 'local-personal',
    includeJobs: true
  })

  await closeBusinessWriteCanary()
  const tsRepository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => tsRepository.close())
  await expect(tsRepository.memoryRoot(root.id, 'local-personal')).resolves.toMatchObject({
    id: root.id
  })
  await expect(tsRepository.memoryStage1Outputs(root.id, 'local-personal')).resolves.toEqual([])
  const nativeSource = new DatabaseSync(dbPath, { readOnly: true })
  expect(nativeSource.prepare('SELECT COUNT(*) AS count FROM memory_roots').get()).toEqual({
    count: 0
  })
  nativeSource.close()
})
