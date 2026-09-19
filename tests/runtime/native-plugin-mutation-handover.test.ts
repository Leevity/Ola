import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { createLegacyDatabaseHandoverSnapshot } from '../../src/runtime/storage/legacy-database-handover'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

const cleanup: Array<() => Promise<void>> = []

function canonicalProjects(rows: unknown[]): unknown[] {
  return rows.map((value) => {
    const row = value as Record<string, unknown>
    return {
      ...row,
      plugin_id: row.plugin_id ?? null,
      working_folder: row.working_folder ?? null,
      ssh_connection_id: row.ssh_connection_id ?? null
    }
  })
}

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('keeps plugin session model/project sync and removal workspace-scoped after handover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-plugin-mutation-handover-'))
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
  const native = <T>(method: string, args: object = {}): Promise<T> =>
    client.request(method, { dbPath, ...args }) as Promise<T>
  expect((await native<{ success: boolean }>('db/initialize')).success).toBe(true)
  for (const [id, workspaceId] of [
    ['team-plugin-session', 'team-a'],
    ['other-plugin-session', 'team-b']
  ]) {
    expect(
      (
        await native<{ success: boolean }>('db/plugin-sessions-create', {
          id,
          pluginId: 'shared-plugin',
          title: id,
          workspaceId,
          createdAt: 1,
          updatedAt: 1
        })
      ).success
    ).toBe(true)
  }
  const source = new DatabaseSync(dbPath)
  source
    .prepare('INSERT INTO projects(id,name,created_at,updated_at,workspace_id) VALUES(?,?,?,?,?)')
    .run('team-project', 'Team project', 1, 1, 'team-a')
  source
    .prepare(
      'INSERT INTO projects(id,name,plugin_id,created_at,updated_at,workspace_id) VALUES(?,?,?,?,?,?)'
    )
    .run('team-plugin-project', 'Plugin project', 'shared-plugin', 1, 1, 'team-a')
  source
    .prepare(
      'INSERT INTO messages(id,session_id,role,content,created_at,sort_order) VALUES(?,?,?,?,?,?)'
    )
    .run('team-plugin-message', 'team-plugin-session', 'user', 'team private', 2, 0)
  source
    .prepare(
      'INSERT INTO messages(id,session_id,role,content,created_at,sort_order) VALUES(?,?,?,?,?,?)'
    )
    .run('other-plugin-message', 'other-plugin-session', 'user', 'other private', 2, 0)
  source.close()

  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backups')
  })
  const repository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => repository.close())

  const nativeProjects = await native<unknown[]>('db/plugin-normal-projects', {
    workspaceId: 'team-a'
  })
  const tsProjects = await repository.normalPluginProjects<unknown>('team-a')
  expect(canonicalProjects(tsProjects)).toEqual(canonicalProjects(nativeProjects))
  await expect(repository.normalPluginProjects('team-b')).resolves.toEqual([])

  const syncModels = {
    pluginId: 'shared-plugin',
    workspaceId: 'team-a',
    providerId: 'ola-managed:team-a',
    modelId: 'team-model',
    modelSource: JSON.stringify({
      kind: 'ola-team',
      workspaceId: 'team-a',
      resourceId: 'resource-a'
    })
  }
  const nativeModelResult = await native<{ changed: number }>(
    'db/plugin-sync-session-models',
    syncModels
  )
  await expect(repository.syncPluginSessionModels(syncModels)).resolves.toMatchObject({
    success: true,
    changed: nativeModelResult.changed,
    deleted: 0
  })
  await expect(repository.session('team-plugin-session', 'team-a')).resolves.toMatchObject({
    provider_id: 'ola-managed:team-a',
    model_id: 'team-model',
    model_source: syncModels.modelSource,
    model_selection_mode: 'manual'
  })
  await expect(repository.session('other-plugin-session', 'team-b')).resolves.toMatchObject({
    provider_id: null,
    model_id: null
  })
  await expect(
    repository.syncPluginSessionModels({
      ...syncModels,
      workspaceId: 'team-a',
      providerId: 'ola-managed:team-b'
    })
  ).rejects.toThrow('INVALID_BUSINESS_SESSION_PROVIDER')

  const nativeProjectResult = await native<{ changed: number }>('db/plugin-sync-session-project', {
    pluginId: 'shared-plugin',
    workspaceId: 'team-a',
    projectId: 'team-project'
  })
  await expect(
    repository.syncPluginSessionProject({
      pluginId: 'shared-plugin',
      workspaceId: 'team-a',
      projectId: 'team-project'
    })
  ).resolves.toMatchObject({ success: true, changed: nativeProjectResult.changed, deleted: 0 })
  await expect(repository.session('team-plugin-session', 'team-a')).resolves.toMatchObject({
    project_id: 'team-project',
    working_folder: null
  })
  await expect(
    repository.syncPluginSessionProject({
      pluginId: 'shared-plugin',
      workspaceId: 'team-a',
      projectId: 'missing-project'
    })
  ).resolves.toMatchObject({ success: true, changed: 1 })
  await expect(
    repository.syncPluginSessionProject({
      pluginId: 'shared-plugin',
      workspaceId: 'team-a',
      projectId: 'team-project'
    })
  ).resolves.toMatchObject({ success: true })

  const nativeRemove = await native<{ changed: number; deleted: number }>('db/plugin-remove-data', {
    pluginId: 'shared-plugin',
    workspaceId: 'team-a'
  })
  await expect(
    repository.removePluginData({ pluginId: 'shared-plugin', workspaceId: 'team-a' })
  ).resolves.toMatchObject({
    success: true,
    changed: nativeRemove.changed,
    deleted: nativeRemove.deleted
  })
  await expect(repository.allChannelSessions('team-a')).resolves.toEqual([])
  await expect(repository.messages('other-plugin-session', 'team-b')).resolves.toEqual([
    expect.objectContaining({ content: 'other private' })
  ])
  await expect(
    repository.removePluginData({ pluginId: 'shared-plugin', workspaceId: 'team-b' })
  ).resolves.toMatchObject({
    success: true,
    changed: 1,
    deleted: 1
  })
})
