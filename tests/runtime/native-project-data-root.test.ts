import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('allocates projects beside an explicitly isolated Native database unless a base is supplied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-project-root-'))
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
  const project = await client.request('db/projects-create', {
    dbPath,
    name: 'Isolated project',
    workspaceId: 'local-personal'
  })
  expect(project.working_folder).toBe(join(directory, 'projects', 'Isolated project'))
  expect((await stat(project.working_folder)).isDirectory()).toBe(true)

  const plugin = await client.request('db/projects-ensure-plugin', {
    dbPath,
    pluginId: 'isolated-plugin',
    preferredName: 'Plugin project',
    workspaceId: 'local-personal'
  })
  expect(plugin.working_folder).toBe(join(directory, 'projects', 'Plugin project'))

  const defaultProject = await client.request('db/projects-ensure-default', {
    dbPath,
    workspaceId: 'team-a'
  })
  expect(defaultProject.working_folder).toBe(join(directory, 'projects', 'New Project'))

  const updated = await client.request('db/projects-update', {
    dbPath,
    id: project.id,
    workspaceId: 'local-personal',
    patch: { workingFolder: null },
    allocateLocalFolderIfMissing: true
  })
  expect(updated.success).toBe(true)
  expect(updated.project?.working_folder).toMatch(`${join(directory, 'projects')}/`)

  const customBase = join(directory, 'custom-projects')
  const custom = await client.request('db/projects-create', {
    dbPath,
    name: 'Custom project',
    baseDirectory: customBase,
    workspaceId: 'local-personal'
  })
  expect(custom.working_folder).toBe(join(customBase, 'Custom project'))
})
