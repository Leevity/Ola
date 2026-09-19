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

it('keeps session and project model sources in their workspace after Native handover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-model-source-handover-'))
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
  const ownSource = JSON.stringify({
    kind: 'ola-team',
    workspaceId: 'team-a',
    resourceId: 'resource-a'
  })
  const foreignSource = JSON.stringify({
    kind: 'ola-team',
    workspaceId: 'team-b',
    resourceId: 'resource-b'
  })
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'native-foreign',
        title: 'Rejected',
        mode: 'chat',
        workspaceId: 'team-a',
        modelSource: foreignSource
      })
    ).success
  ).toBe(false)
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'native-foreign-provider',
        title: 'Rejected provider',
        mode: 'chat',
        workspaceId: 'team-a',
        providerId: 'ola-managed:team-b'
      })
    ).success
  ).toBe(false)
  expect(
    await client.request('db/projects-create', {
      dbPath,
      id: 'native-foreign-project',
      name: 'Rejected',
      workspaceId: 'team-a',
      modelSource: foreignSource
    })
  ).toHaveProperty('error')
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'native-team-session',
        title: 'Native team session',
        mode: 'chat',
        workspaceId: 'team-a',
        modelSource: ownSource
      })
    ).success
  ).toBe(true)
  expect(
    (
      await client.request('db/sessions-update', {
        dbPath,
        id: 'native-team-session',
        workspaceId: 'team-a',
        patch: { providerId: 'ola-managed:team-b' }
      })
    ).success
  ).toBe(false)
  for (const [method, args] of [
    ['db/plugin-sessions-create', { pluginId: 'plugin-a', title: 'Rejected' }],
    ['db/plugin-route-session', { pluginId: 'plugin-a', chatId: 'chat-a' }],
    ['db/plugin-sync-session-models', { pluginId: 'plugin-a' }]
  ] as const) {
    const response = await client.request(method, {
      dbPath,
      workspaceId: 'team-a',
      providerId: 'ola-managed:team-b',
      ...args
    })
    expect(JSON.stringify(response)).toContain('Managed provider is not available')
  }
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'native-manual-session',
        title: 'Manual model',
        mode: 'chat',
        workspaceId: 'team-a',
        providerId: 'ola-managed:team-a',
        modelId: 'model-a'
      })
    ).success
  ).toBe(true)
  expect(
    (
      await client.request('db/plans-create', {
        dbPath,
        id: 'native-manual-plan',
        sessionId: 'native-manual-session',
        workspaceId: 'team-a',
        title: 'Native plan',
        createdAt: 1,
        updatedAt: 1
      })
    ).success
  ).toBe(true)
  expect(
    (
      await client.request('db/sessions-update', {
        dbPath,
        id: 'native-team-session',
        workspaceId: 'team-a',
        patch: { planId: 'native-manual-plan' }
      })
    ).success
  ).toBe(false)
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'native-cross-plan-session',
        title: 'Rejected plan',
        mode: 'chat',
        workspaceId: 'team-a',
        planId: 'native-manual-plan'
      })
    ).success
  ).toBe(false)
  expect(
    await client.request('db/projects-create', {
      dbPath,
      id: 'native-team-project',
      name: 'Native team project',
      workspaceId: 'team-a',
      workingFolder: join(directory, 'team-workspace'),
      sshConnectionId: 'ssh-team',
      modelSource: ownSource
    })
  ).toMatchObject({ id: 'native-team-project', model_source: ownSource })
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'native-project-session',
        title: 'Native project session',
        mode: 'chat',
        workspaceId: 'team-a',
        projectId: 'native-team-project'
      })
    ).success
  ).toBe(true)

  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backups')
  })
  const repository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => repository.close())
  expect(
    (await repository.session<{ model_source: string }>('native-team-session', 'team-a'))
      ?.model_source
  ).toBe(ownSource)
  expect(
    (await repository.project<{ model_source: string }>('native-team-project', 'team-a'))
      ?.model_source
  ).toBe(ownSource)
  expect(
    await repository.session<{
      working_folder: string
      ssh_connection_id: string
    }>('native-project-session', 'team-a')
  ).toMatchObject({
    working_folder: join(directory, 'team-workspace'),
    ssh_connection_id: 'ssh-team'
  })
  expect(
    (await repository.session<{ model_selection_mode: string }>('native-manual-session', 'team-a'))
      ?.model_selection_mode
  ).toBe('manual')

  const sessionInput = {
    id: 'team-session',
    title: 'Team session',
    mode: 'chat',
    workspaceId: 'team-a',
    createdAt: 1,
    updatedAt: 1
  }
  await expect(
    repository.createSession({ ...sessionInput, modelSource: foreignSource })
  ).rejects.toThrow('INVALID_BUSINESS_MODEL_SOURCE')
  await expect(
    repository.createSession({ ...sessionInput, providerId: 'ola-managed:team-b' })
  ).rejects.toThrow('INVALID_BUSINESS_SESSION_PROVIDER')
  await expect(
    repository.createSession({ ...sessionInput, planId: 'native-manual-plan' })
  ).rejects.toThrow('BUSINESS_SESSION_PLAN_MISMATCH')
  for (const invalidSource of [
    JSON.stringify({ kind: 'local', providerId: 'provider', modelId: 'model', extra: true }),
    JSON.stringify({ kind: 'local', providerId: 'provider\u0080', modelId: 'model' })
  ]) {
    await expect(
      repository.createSession({ ...sessionInput, modelSource: invalidSource })
    ).rejects.toThrow('INVALID_BUSINESS_MODEL_SOURCE')
  }
  const session = await repository.createSession<{ model_source: string }>({
    ...sessionInput,
    modelSource: ownSource
  })
  expect(session.model_source).toBe(ownSource)
  await expect(
    repository.updateSession({
      id: sessionInput.id,
      workspaceId: 'team-a',
      modelSource: foreignSource
    })
  ).rejects.toThrow('INVALID_BUSINESS_MODEL_SOURCE')
  await expect(
    repository.updateSession({
      id: sessionInput.id,
      workspaceId: 'team-a',
      providerId: 'ola-managed:team-b'
    })
  ).rejects.toThrow('INVALID_BUSINESS_SESSION_PROVIDER')
  await expect(
    repository.updateSession({
      id: sessionInput.id,
      workspaceId: 'team-a',
      planId: 'native-manual-plan'
    })
  ).rejects.toThrow('BUSINESS_SESSION_PLAN_MISMATCH')
  expect(
    (
      await repository.updateSession<{ plan_id: string }>({
        id: 'native-manual-session',
        workspaceId: 'team-a',
        planId: 'native-manual-plan'
      })
    ).plan_id
  ).toBe('native-manual-plan')
  expect(
    (await repository.session<{ model_source: string }>(sessionInput.id, 'team-a'))?.model_source
  ).toBe(ownSource)
  expect(
    (
      await repository.updateSession<{ model_source: string | null }>({
        id: sessionInput.id,
        workspaceId: 'team-a',
        modelSource: '   '
      })
    ).model_source
  ).toBeNull()
  expect(
    (
      await repository.createSession<{ model_selection_mode: string }>({
        ...sessionInput,
        id: 'ts-manual-session',
        providerId: 'ola-managed:team-a',
        modelId: 'model-a'
      })
    ).model_selection_mode
  ).toBe('manual')
  const inheritedSession = await repository.createSession<{
    model_selection_mode: string
    provider_id: string | null
  }>({
    ...sessionInput,
    id: 'ts-inherit-session',
    providerId: '   ',
    modelId: 'model-a'
  })
  expect(inheritedSession).toMatchObject({ model_selection_mode: 'inherit', provider_id: null })
  expect(
    await repository.createSession<{
      working_folder: string
      ssh_connection_id: string
    }>({
      ...sessionInput,
      id: 'ts-project-session',
      projectId: 'native-team-project'
    })
  ).toMatchObject({
    working_folder: join(directory, 'team-workspace'),
    ssh_connection_id: 'ssh-team'
  })
  expect(
    await repository.createSession<{
      working_folder: string
      ssh_connection_id: string
    }>({
      ...sessionInput,
      id: 'ts-project-partial-override',
      projectId: 'native-team-project',
      workingFolder: join(directory, 'override-workspace')
    })
  ).toMatchObject({
    working_folder: join(directory, 'override-workspace'),
    ssh_connection_id: 'ssh-team'
  })

  const projectInput = {
    id: 'team-project',
    name: 'Team project',
    workspaceId: 'team-a',
    createdAt: 1,
    updatedAt: 1
  }
  await expect(
    repository.createProject({ ...projectInput, modelSource: foreignSource })
  ).rejects.toThrow('INVALID_BUSINESS_MODEL_SOURCE')
  const project = await repository.createProject<{ model_source: string }>({
    ...projectInput,
    modelSource: ownSource
  })
  expect(project.model_source).toBe(ownSource)
  await expect(
    repository.updateProject({
      id: projectInput.id,
      workspaceId: 'team-a',
      modelSource: foreignSource
    })
  ).rejects.toThrow('INVALID_BUSINESS_MODEL_SOURCE')
  expect(
    (await repository.project<{ model_source: string }>(projectInput.id, 'team-a'))?.model_source
  ).toBe(ownSource)
  await expect(
    repository.createChannelSession({
      id: 'bad-channel-session',
      pluginId: 'plugin-a',
      title: 'Rejected',
      workspaceId: 'team-a',
      providerId: 'ola-managed:team-b'
    })
  ).rejects.toThrow('INVALID_BUSINESS_SESSION_PROVIDER')
  await expect(
    repository.routeChannelSession({
      pluginId: 'plugin-a',
      chatId: 'chat-a',
      workspaceId: 'team-a',
      providerId: 'ola-managed:team-b'
    })
  ).rejects.toThrow('INVALID_BUSINESS_SESSION_PROVIDER')
})
