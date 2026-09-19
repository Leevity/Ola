import { afterEach, expect, it } from 'vitest'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { createLegacyDatabaseHandoverSnapshot } from '../../src/runtime/storage/legacy-database-handover'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('ensures workspace-scoped default and plugin projects after a Native handover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-project-ensure-handover-'))
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
  const db = new DatabaseSync(dbPath)
  db.prepare(
    `INSERT INTO projects(id,name,working_folder,ssh_connection_id,plugin_id,pinned,
      created_at,updated_at,workspace_id,model_source) VALUES(?,?,NULL,?,NULL,0,1,1,?,NULL)`
  ).run('team-default', 'Sales/ Ops', null, 'team-a')
  db.prepare(
    `INSERT INTO projects(id,name,working_folder,ssh_connection_id,plugin_id,pinned,
      created_at,updated_at,workspace_id,model_source) VALUES(?,?,NULL,?,NULL,0,1,1,?,NULL)`
  ).run('remote-default', 'Remote', 'ssh-team-b', 'team-b')
  db.close()

  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backups')
  })
  const repository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => repository.close())
  const nativeBase = join(directory, 'native-projects')
  const tsBase = join(directory, 'ts-projects')

  const nativeDefault = await client.request('db/projects-ensure-default', {
    dbPath,
    workspaceId: 'team-a',
    baseDirectory: nativeBase
  })
  const tsDefault = await repository.ensureDefaultProject<{
    id: string
    name: string
    working_folder: string
    workspace_id: string
  }>({ workspaceId: 'team-a', baseDirectory: tsBase })
  expect(tsDefault).toMatchObject({
    id: 'team-default',
    name: nativeDefault.name,
    workspace_id: 'team-a'
  })
  expect(basename(tsDefault.working_folder)).toBe(basename(nativeDefault.working_folder))
  await access(tsDefault.working_folder)
  await expect(
    repository.ensureDefaultProject({ workspaceId: 'team-a', baseDirectory: tsBase })
  ).resolves.toEqual(tsDefault)
  expect(await readdir(tsBase)).toEqual(['Sales Ops'])
  await expect(
    repository.ensureDefaultProject({ workspaceId: 'team-b', baseDirectory: tsBase })
  ).resolves.toMatchObject({
    id: 'remote-default',
    working_folder: null,
    ssh_connection_id: 'ssh-team-b'
  })

  const nativePlugin = await client.request('db/projects-ensure-plugin', {
    dbPath,
    pluginId: 'plugin-a',
    preferredName: 'Sales/ Ops',
    workspaceId: 'team-a',
    baseDirectory: nativeBase
  })
  const tsPlugin = await repository.ensurePluginProject<{
    id: string
    name: string
    plugin_id: string
    working_folder: string
    workspace_id: string
  }>({
    pluginId: 'plugin-a',
    preferredName: 'Sales/ Ops',
    workspaceId: 'team-a',
    baseDirectory: tsBase
  })
  expect(tsPlugin.id).toMatch(/^oc_[0-9a-f]{32}$/)
  expect(tsPlugin).toMatchObject({
    name: nativePlugin.name,
    plugin_id: 'plugin-a',
    workspace_id: 'team-a'
  })
  expect(basename(tsPlugin.working_folder)).toBe(basename(nativePlugin.working_folder))
  await access(tsPlugin.working_folder)
  await expect(
    repository.ensurePluginProject({
      pluginId: 'plugin-a',
      workspaceId: 'team-a',
      baseDirectory: tsBase
    })
  ).resolves.toEqual(tsPlugin)
  expect((await readdir(tsBase)).sort()).toEqual(['Sales Ops', 'Sales Ops (1)'])

  const nativeNewDefault = await client.request('db/projects-ensure-default', {
    dbPath,
    workspaceId: 'team-c',
    baseDirectory: nativeBase
  })
  const tsNewDefault = await repository.ensureDefaultProject<{
    id: string
    name: string
    working_folder: string
    workspace_id: string
  }>({ workspaceId: 'team-c', baseDirectory: tsBase })
  expect(tsNewDefault.id).toMatch(/^oc_[0-9a-f]{32}$/)
  expect(tsNewDefault).toMatchObject({ name: nativeNewDefault.name, workspace_id: 'team-c' })
  expect(basename(tsNewDefault.working_folder)).toBe(basename(nativeNewDefault.working_folder))
  await expect(
    repository.ensureDefaultProject({ workspaceId: 'team-c', baseDirectory: tsBase })
  ).resolves.toEqual(tsNewDefault)

  const teamBPlugin = await repository.ensurePluginProject<{
    id: string
    name: string
    plugin_id: string
    workspace_id: string
  }>({ pluginId: 'plugin-a', workspaceId: 'team-b', baseDirectory: tsBase })
  expect(teamBPlugin).toMatchObject({
    name: 'Plugin plugin-a',
    plugin_id: 'plugin-a',
    workspace_id: 'team-b'
  })
  expect(teamBPlugin.id).not.toBe(tsPlugin.id)
  await expect(
    repository.ensurePluginProject({
      pluginId: 'plugin-b',
      workspaceId: 'team-a',
      baseDirectory: 'relative/path'
    })
  ).rejects.toThrow('INVALID_BUSINESS_PROJECT_BASE_DIRECTORY')
})
