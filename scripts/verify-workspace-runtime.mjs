import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from './verify-message-windowing.mjs'

const dir = await mkdtemp(path.join(tmpdir(), 'ola-workspace-'))
const dbPath = path.join(dir, 'workspace.db')
let client
let child
try {
  ;({ client, child } = await startWorker(dir))
  const runtimeRoutes = await client.request('worker/routes')
  const inventory = JSON.parse(
    await readFile(
      new URL('../docs/migrations/ts-runtime/capability-inventory.json', import.meta.url)
    )
  )
  const literalRoutes = new Set(
    inventory.routes
      .filter((route) => route.source.startsWith('sidecars/Ola.Native.Worker/'))
      .map((route) => route.method)
  )
  const liveRoutes = new Set(runtimeRoutes.methods)
  assert.deepEqual(
    [...liveRoutes].filter((method) => !literalRoutes.has(method)).sort(),
    [],
    'Native Worker has runtime routes missing from the migration inventory'
  )
  assert.deepEqual(
    [...literalRoutes].filter((method) => !liveRoutes.has(method)).sort(),
    [],
    'Migration inventory contains Native Worker routes absent at runtime'
  )
  assert.equal((await client.request('db/initialize', { dbPath })).success, true)
  for (const workspaceId of ['local-personal', 'team-a', 'team-b']) {
    await client.request('db/projects-create', {
      dbPath,
      id: `p-${workspaceId}`,
      name: workspaceId,
      workspaceId,
      baseDirectory: path.join(dir, 'projects')
    })
    await client.request('db/sessions-create', {
      dbPath,
      id: `s-${workspaceId}`,
      title: workspaceId,
      mode: 'chat',
      workspaceId,
      projectId: `p-${workspaceId}`
    })
    await client.request('db/tasks-create', {
      dbPath,
      id: `t-${workspaceId}`,
      sessionId: `s-${workspaceId}`,
      workspaceId,
      subject: workspaceId,
      description: '',
      status: 'pending'
    })
    const plan = await client.request('db/plans-create', {
      dbPath,
      id: `plan-${workspaceId}`,
      sessionId: `s-${workspaceId}`,
      workspaceId,
      title: workspaceId,
      status: 'drafting',
      createdAt: 1,
      updatedAt: 1
    })
    assert.equal(plan.success, true)
  }
  const memoryPath = path.join(dir, 'shared-memory.md')
  const localMemoryRoot = await client.request('db/memory-roots-ensure', {
    dbPath,
    scope: 'global',
    rootPath: memoryPath,
    transport: 'local'
  })
  const localMemoryRootAgain = await client.request('db/memory-roots-ensure', {
    dbPath,
    workspaceId: 'local-personal',
    scope: 'global',
    rootPath: memoryPath,
    transport: 'local'
  })
  assert.equal(
    localMemoryRoot.id,
    localMemoryRootAgain.id,
    'legacy personal root key must remain stable'
  )
  const teamRoots = []
  for (const workspaceId of ['team-a', 'team-b']) {
    const root = await client.request('db/memory-roots-ensure', {
      dbPath,
      workspaceId,
      scope: 'global',
      rootPath: memoryPath,
      transport: 'local'
    })
    assert.equal(root.workspaceId, workspaceId)
    teamRoots.push(root)
    assert.deepEqual(
      (await client.request('db/memory-roots-list', { dbPath, workspaceId })).map(
        (item) => item.id
      ),
      [root.id]
    )
  }
  assert.notEqual(teamRoots[0].id, teamRoots[1].id, 'memory roots must be owned per workspace')
  assert.equal(
    (
      await client.request('db/memory-roots-get', {
        dbPath,
        id: teamRoots[0].id,
        workspaceId: 'team-b'
      })
    ).root == null,
    true,
    'memory roots must not be readable from another workspace'
  )
  const crossMemoryProject = await client.request('db/memory-roots-ensure', {
    dbPath,
    workspaceId: 'team-b',
    scope: 'project',
    projectId: 'p-team-a',
    rootPath: memoryPath,
    transport: 'local'
  })
  assert.ok(crossMemoryProject.error, 'memory roots must reject a foreign project')
  const stage1Input = {
    dbPath,
    workspaceId: 'team-a',
    memoryRootId: teamRoots[0].id,
    scope: 'global',
    sourceSessionId: 'memory-source',
    rawMemory: 'team-a-only',
    rolloutSummary: 'team-a-only',
    rolloutSlug: 'team-a-only',
    fingerprint: 'team-a-only'
  }
  const stage1Output = await client.request('db/memory-stage1-add', stage1Input)
  assert.equal(stage1Output.rawMemory, 'team-a-only')
  assert.ok(
    (await client.request('db/memory-stage1-add', { ...stage1Input, workspaceId: 'team-b' })).error,
    'memory outputs must reject a foreign root'
  )
  assert.deepEqual(
    (
      await client.request('db/memory-stage1-list', {
        dbPath,
        workspaceId: 'team-a',
        memoryRootId: teamRoots[0].id
      })
    ).map((item) => item.id),
    [stage1Output.id]
  )
  assert.ok(
    (
      await client.request('db/memory-stage1-list', {
        dbPath,
        workspaceId: 'team-b',
        memoryRootId: teamRoots[0].id
      })
    ).error,
    'memory outputs must not be listed from another workspace'
  )
  const foreignClear = await client.request('db/memory-root-clear', {
    dbPath,
    workspaceId: 'team-b',
    memoryRootId: teamRoots[0].id
  })
  assert.equal(foreignClear.success, false, 'foreign workspace must not clear a memory root')
  const foreignCitation = await client.request('db/memory-citation-record', {
    dbPath,
    workspaceId: 'team-b',
    memoryRootId: teamRoots[0].id,
    scope: 'global',
    path: memoryPath
  })
  assert.equal(foreignCitation.success, false, 'foreign workspace must not record citation usage')
  assert.equal(
    (
      await client.request('db/memory-stage1-list', {
        dbPath,
        workspaceId: 'team-a',
        memoryRootId: teamRoots[0].id
      })
    ).length,
    1,
    'foreign clear must leave the owner workspace output intact'
  )
  const teamMemoryJob = await client.request('db/memory-jobs-create', {
    dbPath,
    workspaceId: 'team-a',
    kind: 'stage1',
    memoryRootId: teamRoots[0].id,
    sourceSessionId: 's-team-a'
  })
  assert.equal(teamMemoryJob.workspaceId, 'team-a')
  assert.ok(
    (
      await client.request('db/memory-jobs-create', {
        dbPath,
        workspaceId: 'team-b',
        kind: 'stage1',
        memoryRootId: teamRoots[0].id,
        sourceSessionId: 's-team-b'
      })
    ).error,
    'memory jobs must reject a foreign root'
  )
  assert.ok(
    (
      await client.request('db/memory-jobs-create', {
        dbPath,
        workspaceId: 'team-a',
        kind: 'stage1',
        sourceSessionId: 's-team-b'
      })
    ).error,
    'memory jobs must reject a foreign source session'
  )
  assert.ok(
    (
      await client.request('db/memory-jobs-get', {
        dbPath,
        workspaceId: 'team-b',
        id: teamMemoryJob.id
      })
    ).job == null,
    'memory jobs must not be readable from another workspace'
  )
  assert.deepEqual(
    await client.request('db/memory-jobs-list', { dbPath, workspaceId: 'team-b' }),
    [],
    'memory jobs must not be listed from another workspace'
  )
  assert.ok(
    (
      await client.request('db/memory-jobs-finish', {
        dbPath,
        workspaceId: 'team-b',
        id: teamMemoryJob.id,
        status: 'failed'
      })
    ).job == null,
    'memory jobs must not be finished from another workspace'
  )
  assert.equal(
    (
      await client.request('db/memory-jobs-get', {
        dbPath,
        workspaceId: 'team-a',
        id: teamMemoryJob.id
      })
    ).job.status,
    'running'
  )
  const memoryEntryInput = {
    dbPath,
    workspaceId: 'team-a',
    scope: 'main',
    memoryRootId: teamRoots[0].id,
    jobId: teamMemoryJob.id,
    sourceSessionId: 's-team-a',
    target: 'global_memory',
    kind: 'workflow_habit',
    content: 'team-a-only',
    status: 'written',
    fingerprint: 'team-a-only'
  }
  const memoryEntry = await client.request('db/memory-automation-add', memoryEntryInput)
  assert.equal(memoryEntry.entry.workspaceId, 'team-a')
  assert.equal(
    (
      await client.request('db/memory-automation-add', {
        ...memoryEntryInput,
        workspaceId: 'team-b'
      })
    ).success,
    false,
    'memory entries must reject cross-workspace associations'
  )
  assert.deepEqual(
    await client.request('db/memory-automation-list', { dbPath, workspaceId: 'team-b' }),
    [],
    'memory entries must not be listed from another workspace'
  )
  assert.ok(
    (
      await client.request('db/memory-automation-get', {
        dbPath,
        workspaceId: 'team-b',
        id: memoryEntry.entry.id
      })
    ).entry == null,
    'memory entries must not be read by ID from another workspace'
  )
  assert.ok(
    (
      await client.request('db/memory-automation-mark-undo', {
        dbPath,
        workspaceId: 'team-b',
        id: memoryEntry.entry.id
      })
    ).entry == null,
    'memory entries must not be modified from another workspace'
  )
  const rollupKey = {
    dbPath,
    scope: 'main',
    target: 'project_memory',
    targetPath: memoryPath,
    sourceDate: '2026-01-01',
    contentHash: 'shared-hash'
  }
  assert.equal(
    (
      await client.request('db/memory-automation-rollup-mark', {
        ...rollupKey,
        workspaceId: 'team-a'
      })
    ).success,
    true
  )
  assert.equal(
    (
      await client.request('db/memory-automation-rollup-has', {
        ...rollupKey,
        workspaceId: 'team-b'
      })
    ).alreadyProcessed,
    false,
    'rollup watermarks must not cross workspaces with identical paths and hashes'
  )
  const legacyMemoryDb = new DatabaseSync(dbPath)
  try {
    legacyMemoryDb
      .prepare(
        "INSERT INTO memory_jobs (id, kind, status, memory_root_id, source_session_id, created_at, updated_at) VALUES ('legacy-team-memory-job', 'stage1', 'succeeded', ?, ?, 1, 1)"
      )
      .run(teamRoots[1].id, 's-team-b')
    legacyMemoryDb
      .prepare(
        "INSERT INTO memory_automation_entries (id, scope, memory_root_id, target, kind, content, status, fingerprint, created_at, updated_at) VALUES ('legacy-team-memory-entry', 'main', ?, 'global_memory', 'workflow_habit', 'legacy', 'written', 'legacy', 1, 1)"
      )
      .run(teamRoots[1].id)
  } finally {
    legacyMemoryDb.close()
  }
  assert.equal((await client.request('db/initialize', { dbPath })).success, true)
  assert.equal(
    (
      await client.request('db/memory-jobs-get', {
        dbPath,
        workspaceId: 'team-b',
        id: 'legacy-team-memory-job'
      })
    ).job.workspaceId,
    'team-b',
    'schema migration must backfill legacy memory job ownership'
  )
  assert.equal(
    (
      await client.request('db/memory-automation-get', {
        dbPath,
        workspaceId: 'team-b',
        id: 'legacy-team-memory-entry'
      })
    ).entry.workspaceId,
    'team-b',
    'schema migration must backfill legacy memory entry ownership'
  )
  await client.request('db/sessions-create', {
    dbPath,
    id: 'legacy',
    title: 'Legacy',
    mode: 'chat'
  })
  const legacy = await client.request('db/sessions-get', { dbPath, id: 'legacy' })
  assert.equal(legacy.session.workspace_id, 'local-personal')
  const invalidSessionCreate = await client.request('db/sessions-create', {
    dbPath,
    id: 's-invalid-source',
    title: 'Invalid source',
    mode: 'chat',
    workspaceId: 'team-a',
    modelSource: JSON.stringify({
      kind: 'ola-team',
      workspaceId: 'team-b',
      resourceId: 'team-model-b'
    })
  })
  assert.equal(
    invalidSessionCreate.success,
    false,
    'new sessions must reject cross-workspace resources'
  )
  const invalidProjectCreate = await client.request('db/projects-create', {
    dbPath,
    id: 'p-invalid-source',
    name: 'Invalid source',
    workspaceId: 'team-a',
    baseDirectory: path.join(dir, 'projects'),
    modelSource: JSON.stringify({
      kind: 'ola-team',
      workspaceId: 'team-b',
      resourceId: 'team-model-b'
    })
  })
  assert.ok(invalidProjectCreate.error, 'new projects must reject cross-workspace resources')
  for (const workspaceId of ['team-a', 'team-b']) {
    assert.deepEqual(
      (await client.request('db/sessions-list', { dbPath, workspaceId })).map((s) => s.id),
      [`s-${workspaceId}`]
    )
    assert.deepEqual(
      (await client.request('db/projects-list', { dbPath, workspaceId })).map((s) => s.id),
      [`p-${workspaceId}`]
    )
    assert.deepEqual(
      (await client.request('db/tasks-list-all', { dbPath, workspaceId })).map((s) => s.id),
      [`t-${workspaceId}`]
    )
    assert.deepEqual(
      (await client.request('db/plans-list', { dbPath, workspaceId })).map((plan) => plan.id),
      [`plan-${workspaceId}`]
    )
    const plan = await client.request('db/plans-get', {
      dbPath,
      id: `plan-${workspaceId}`,
      workspaceId
    })
    assert.equal(plan.plan.workspace_id, workspaceId)
  }
  for (const workspaceId of ['team-a', 'team-b']) {
    const job = {
      id: `cron-${workspaceId}`,
      workspace_id: workspaceId,
      session_id: `s-${workspaceId}`,
      name: workspaceId,
      schedule_kind: 'every',
      schedule_every: 60_000,
      prompt: 'Workspace cron smoke test'
    }
    const created = await client.request('db/cron-jobs-create', { dbPath, job })
    assert.equal(created.success, true, created.error)
    const listed = await client.request('db/cron-jobs-list', { dbPath, workspaceId })
    assert.deepEqual(
      listed.jobs.map((item) => item.id),
      [job.id]
    )
    const run = await client.request('db/cron-runs-create', {
      dbPath,
      runId: `run-${workspaceId}`,
      jobId: job.id,
      startedAt: 1
    })
    assert.equal(run.success, true, run.error)
    const runs = await client.request('db/cron-runs-list', { dbPath, workspaceId })
    assert.deepEqual(
      runs.runs.map((item) => item.id),
      [`run-${workspaceId}`]
    )
  }
  const foreignJob = await client.request('db/cron-jobs-get', {
    dbPath,
    jobId: 'cron-team-a',
    workspaceId: 'team-b'
  })
  assert.equal(
    foreignJob.job == null,
    true,
    'cron jobs must not be readable from another workspace'
  )
  const foreignUpdate = await client.request('db/cron-jobs-update', {
    dbPath,
    workspaceId: 'team-b',
    job: {
      id: 'cron-team-a',
      workspace_id: 'team-a',
      session_id: 's-team-a',
      name: 'cross-workspace update',
      schedule_kind: 'every',
      schedule_every: 60_000,
      prompt: 'Workspace cron smoke test'
    }
  })
  assert.equal(foreignUpdate.success, false, 'cron jobs must not update from another workspace')
  const foreignSoftDelete = await client.request('db/cron-jobs-soft-delete', {
    dbPath,
    jobId: 'cron-team-a',
    workspaceId: 'team-b'
  })
  assert.equal(
    foreignSoftDelete.changed,
    0,
    'cron jobs must not soft-delete from another workspace'
  )
  const foreignToggle = await client.request('db/cron-jobs-set-enabled', {
    dbPath,
    jobId: 'cron-team-a',
    workspaceId: 'team-b',
    enabled: false
  })
  assert.equal(foreignToggle.changed, 0, 'cron jobs must not be toggled from another workspace')
  const foreignDelete = await client.request('db/cron-jobs-delete', {
    dbPath,
    jobId: 'cron-team-a',
    workspaceId: 'team-b'
  })
  assert.equal(foreignDelete.changed, 0, 'cron jobs must not be deleted from another workspace')
  const ownJob = await client.request('db/cron-jobs-get', {
    dbPath,
    jobId: 'cron-team-a',
    workspaceId: 'team-a'
  })
  assert.equal(ownJob.job.id, 'cron-team-a')
  assert.equal(ownJob.job.name, 'team-a')
  const foreignRun = await client.request('db/cron-run-detail', {
    dbPath,
    runId: 'run-team-a',
    workspaceId: 'team-b'
  })
  assert.equal(foreignRun.success, false, 'cron run details must not cross workspaces')
  const crossPlanRead = await client.request('db/plans-get', {
    dbPath,
    id: 'plan-team-a',
    workspaceId: 'team-b'
  })
  assert.equal(
    crossPlanRead.plan == null,
    true,
    'plans must not be readable from another workspace'
  )
  const invalidPlanCreate = await client.request('db/plans-create', {
    dbPath,
    id: 'plan-invalid-workspace',
    sessionId: 's-team-a',
    workspaceId: 'team-b',
    title: 'Invalid plan',
    createdAt: 1,
    updatedAt: 1
  })
  assert.equal(invalidPlanCreate.success, false, 'plans must belong to their session workspace')
  const crossPlanUpdate = await client.request('db/plans-update', {
    dbPath,
    id: 'plan-team-a',
    workspaceId: 'team-b',
    patch: { title: 'cross-workspace update' }
  })
  assert.equal(crossPlanUpdate.changed, 0, 'plans must not update from another workspace')
  const unchangedPlan = await client.request('db/plans-get', {
    dbPath,
    id: 'plan-team-a',
    workspaceId: 'team-a'
  })
  assert.equal(unchangedPlan.plan.title, 'team-a')
  const crossPlanDelete = await client.request('db/plans-delete', {
    dbPath,
    id: 'plan-team-a',
    workspaceId: 'team-b'
  })
  assert.equal(crossPlanDelete.changed, 0, 'plans must not delete from another workspace')
  assert.equal(
    (
      await client.request('db/plans-get-by-session', {
        dbPath,
        sessionId: 's-team-a',
        workspaceId: 'team-a'
      })
    ).plan.id,
    'plan-team-a'
  )
  const cross = await client.request('db/sessions-update', {
    dbPath,
    id: 's-team-a',
    patch: { projectId: 'p-team-b' }
  })
  assert.equal(cross.success, false, 'cross-workspace project update must fail')
  const move = await client.request('db/sessions-update', {
    dbPath,
    id: 's-team-a',
    patch: { workspaceId: 'team-b', title: 'Move attempt' }
  })
  assert.equal(move.success, false, 'implicit workspace moves must fail')
  const sessionCrossUpdate = await client.request('db/sessions-update', {
    dbPath,
    id: 's-team-a',
    workspaceId: 'team-b',
    patch: { title: 'cross-workspace update' }
  })
  assert.equal(sessionCrossUpdate.success, false, 'cross-workspace session update must fail')
  const sessionCrossDelete = await client.request('db/sessions-delete', {
    dbPath,
    id: 's-team-a',
    workspaceId: 'team-b'
  })
  assert.equal(sessionCrossDelete.success, false, 'cross-workspace session deletion must fail')
  const crossWorkspaceSessionBinding = await client.request('db/sessions-update', {
    dbPath,
    id: 's-team-a',
    workspaceId: 'team-a',
    patch: {
      modelSource: JSON.stringify({
        kind: 'ola-team',
        workspaceId: 'team-b',
        resourceId: 'team-model-b'
      })
    }
  })
  assert.equal(
    crossWorkspaceSessionBinding.success,
    false,
    'session ModelSource must not bind a managed resource from another workspace'
  )
  const sessionBinding = JSON.stringify({
    kind: 'ola-team',
    workspaceId: 'team-a',
    resourceId: 'team-model-a'
  })
  const sessionBindingUpdate = await client.request('db/sessions-update', {
    dbPath,
    id: 's-team-a',
    workspaceId: 'team-a',
    patch: { modelSource: sessionBinding }
  })
  assert.equal(sessionBindingUpdate.success, true, 'session ModelSource binding must be accepted')
  const boundSession = await client.request('db/sessions-get', {
    dbPath,
    id: 's-team-a',
    workspaceId: 'team-a'
  })
  assert.equal(boundSession.session.model_source, sessionBinding)
  const projectCrossUpdate = await client.request('db/projects-update', {
    dbPath,
    id: 'p-team-a',
    workspaceId: 'team-b',
    patch: { name: 'cross-workspace update' }
  })
  assert.equal(projectCrossUpdate.success, false, 'cross-workspace project update must fail')
  const projectCrossDelete = await client.request('db/projects-delete', {
    dbPath,
    id: 'p-team-a',
    workspaceId: 'team-b'
  })
  assert.equal(projectCrossDelete.success, false, 'cross-workspace project deletion must fail')
  const projectBinding = JSON.stringify({
    kind: 'ola-team',
    workspaceId: 'team-a',
    resourceId: 'team-model-a'
  })
  const projectBindingUpdate = await client.request('db/projects-update', {
    dbPath,
    id: 'p-team-a',
    workspaceId: 'team-a',
    patch: { modelSource: projectBinding }
  })
  assert.equal(projectBindingUpdate.success, true, 'project ModelSource binding must be accepted')
  const boundProject = await client.request('db/projects-get', {
    dbPath,
    id: 'p-team-a',
    workspaceId: 'team-a'
  })
  assert.equal(boundProject.project.model_source, projectBinding)
  const unsafeProjectBinding = await client.request('db/projects-update', {
    dbPath,
    id: 'p-team-a',
    workspaceId: 'team-a',
    patch: {
      modelSource: JSON.stringify({
        kind: 'local',
        providerId: 'lan',
        modelId: 'm',
        apiKey: 'must-not-persist'
      })
    }
  })
  assert.equal(unsafeProjectBinding.success, false, 'project ModelSource must reject secrets')
  const crossWorkspaceBinding = await client.request('db/projects-update', {
    dbPath,
    id: 'p-team-a',
    workspaceId: 'team-a',
    patch: {
      modelSource: JSON.stringify({
        kind: 'ola-team',
        workspaceId: 'team-b',
        resourceId: 'team-model-b'
      })
    }
  })
  assert.equal(
    crossWorkspaceBinding.success,
    false,
    'project ModelSource must not bind a managed resource from another workspace'
  )
  const routedChannelBinding = JSON.stringify({
    kind: 'ola-team',
    workspaceId: 'team-a',
    resourceId: 'team-model-a'
  })
  const routedChannelSession = await client.request('db/plugin-route-session', {
    dbPath,
    pluginId: 'channel-team-a',
    chatId: 'chat-a',
    projectId: 'p-team-a',
    workspaceId: 'team-a',
    providerId: 'ola-managed:team-a',
    modelId: 'team-model-a',
    modelSource: routedChannelBinding
  })
  assert.equal(routedChannelSession.success, true, 'channel route must create its scoped session')
  const routedStoredSession = await client.request('db/sessions-get', {
    dbPath,
    id: routedChannelSession.sessionId,
    workspaceId: 'team-a'
  })
  assert.equal(routedStoredSession.session.workspace_id, 'team-a')
  assert.equal(routedStoredSession.session.model_source, routedChannelBinding)
  const crossChannelModelRoute = await client.request('db/plugin-route-session', {
    dbPath,
    pluginId: 'channel-invalid-model',
    chatId: 'chat-invalid-model',
    workspaceId: 'team-a',
    modelSource: JSON.stringify({
      kind: 'ola-team',
      workspaceId: 'team-b',
      resourceId: 'team-model-b'
    })
  })
  assert.equal(
    crossChannelModelRoute.success,
    false,
    'channel route must reject a managed model from another workspace'
  )
  const crossChannelProjectRoute = await client.request('db/plugin-route-session', {
    dbPath,
    pluginId: 'channel-invalid-project',
    chatId: 'chat-invalid-project',
    projectId: 'p-team-b',
    workspaceId: 'team-a'
  })
  assert.equal(
    crossChannelProjectRoute.success,
    false,
    'channel route must reject a project from another workspace'
  )
  const crossExistingChannelRoute = await client.request('db/plugin-route-session', {
    dbPath,
    pluginId: 'channel-team-a',
    chatId: 'chat-a',
    workspaceId: 'team-b'
  })
  assert.equal(
    crossExistingChannelRoute.success,
    false,
    'channel route must not reopen a session through another workspace'
  )
  const crossChannelProjectSync = await client.request('db/plugin-sync-session-project', {
    dbPath,
    pluginId: 'channel-team-a',
    projectId: 'p-team-b',
    workspaceId: 'team-a'
  })
  assert.equal(
    crossChannelProjectSync.success,
    false,
    'channel project synchronization must reject a project from another workspace'
  )
  const scopedChannelProjectSync = await client.request('db/plugin-sync-session-project', {
    dbPath,
    pluginId: 'channel-team-a',
    projectId: 'p-team-a',
    workspaceId: 'team-a'
  })
  assert.equal(scopedChannelProjectSync.success, true)
  const taskCrossUpdate = await client.request('db/tasks-update', {
    dbPath,
    id: 't-team-a',
    workspaceId: 'team-b',
    patch: { subject: 'cross-workspace update' }
  })
  assert.equal(taskCrossUpdate.success, false, 'cross-workspace task update must fail')
  const taskCrossDelete = await client.request('db/tasks-delete', {
    dbPath,
    id: 't-team-a',
    workspaceId: 'team-b'
  })
  assert.equal(taskCrossDelete.success, false, 'cross-workspace task deletion must fail')

  // Exercise real Worker HTTP parsing and backpressure through the reverse IPC stream.
  const opened = []
  let reads = 0
  let chunks = [
    'data: {"choices":[{"index":0,"delta":{"content":"workspace stream"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  ]
  client.onEvent('agent/reverse-request', (event) => {
    void (async () => {
      const { id, method, params } = event.params
      let result
      if (method === 'ola/model-open') {
        opened.push(params)
        if (params.url.endsWith('/images/generations')) {
          reads = 0
          chunks = [
            JSON.stringify({
              data: [
                {
                  b64_json:
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
                }
              ]
            })
          ]
        }
        if (params.url.endsWith('/audio/transcriptions')) {
          reads = 0
          chunks = [JSON.stringify({ text: 'workspace audio' })]
        }
        result = { handle: 'test-stream', status: 200, contentType: 'text/event-stream' }
      } else if (method === 'ola/model-read') {
        result = {
          done: reads >= chunks.length,
          data: Buffer.from(chunks[reads++] ?? '').toString('base64')
        }
      } else if (method === 'ola/model-close') result = { closed: true }
      else throw new Error(`Unexpected reverse method ${method}`)
      await client.request('agent/reverse-response', { id, result })
    })().catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
  })
  await client.request('agent/run', {
    dbPath,
    runId: 'workspace-stream',
    sessionId: 's-team-a',
    provider: {
      type: 'openai-chat',
      apiKey: '',
      requiresApiKey: false,
      model: 'resource-a',
      baseUrl: 'https://ola.invalid/workspaces/team-a/resources/resource-a/v1'
    },
    messages: [{ id: 'user', role: 'user', content: 'Hello', createdAt: Date.now() }],
    tools: [],
    maxIterations: 1,
    forceApproval: false
  })
  const deadline = Date.now() + 15_000
  while (reads < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(opened.length, 1, 'managed request must cross IPC rather than reach DNS')
  assert.equal(opened[0].sessionId, 's-team-a')
  assert.ok(reads >= 2, 'Worker must consume streaming chunks')
  assert.equal('authorization' in opened[0], false)
  const mediaProvider = {
    type: 'openai-chat',
    apiKey: '',
    requiresApiKey: false,
    model: 'resource-a',
    sessionId: 's-team-a',
    baseUrl: 'https://ola.invalid/workspaces/team-a/resources/resource-a/v1'
  }
  const image = await client.request('openai-images/generate', {
    provider: mediaProvider,
    prompt: 'Test image',
    images: []
  })
  assert.equal(image.images.length, 1)
  const audio = await client.request('openai-audio/transcribe', {
    provider: mediaProvider,
    file: {
      base64: Buffer.from('fixture audio').toString('base64'),
      mediaType: 'audio/wav',
      fileName: 'fixture.wav'
    }
  })
  assert.equal(audio.text, 'workspace audio')
  assert.equal(opened.length, 3)
  assert.ok(opened.every((request) => request.sessionId === 's-team-a'))
  await client.request('db/sessions-clear-all', { dbPath, workspaceId: 'team-a' })
  assert.equal(
    (await client.request('db/sessions-list', { dbPath, workspaceId: 'team-a' })).length,
    1,
    'clearing ordinary sessions must not delete the routed channel session'
  )
  assert.equal(
    (await client.request('db/sessions-list', { dbPath, workspaceId: 'team-b' })).length,
    1
  )
  console.log('Workspace database isolation and managed streaming verification passed')
} finally {
  client?.close()
  child?.kill('SIGTERM')
  if (child && child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
  await rm(dir, { recursive: true, force: true })
}
