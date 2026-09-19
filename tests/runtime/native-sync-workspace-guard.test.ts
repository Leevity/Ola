import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('fails closed before global WebDAV capture when Native contains team data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-native-sync-workspace-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const dbPath = join(directory, 'native.db')
  const { client, child } = await startWorker(directory)
  cleanup.push(async () => {
    client.close()
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
  expect(await client.request('db/initialize', { dbPath })).toMatchObject({ success: true })
  expect(
    await client.request('db/sync-capture-local', { dbPath, providerId: 'webdav' })
  ).toMatchObject({
    success: true
  })
  expect(
    await client.request('db/sync-apply-db-merge', {
      dbPath,
      recordsToApply: [
        {
          domain: 'db:desktop_flows',
          recordId: 'remote-team',
          value: { table: 'desktop_flows', row: { id: 'remote-team', workspace_id: 'team-a' } }
        }
      ],
      recordsToDelete: []
    })
  ).toMatchObject({ success: false, error: 'LEGACY_SYNC_TEAM_WORKSPACE_UNSUPPORTED' })
  const teamFlow = {
    id: 'team-flow',
    name: 'Team flow',
    workspaceId: 'team-a',
    createdAt: 1,
    updatedAt: 1,
    steps: []
  }
  expect(
    await client.request('db/desktop-flow-save', {
      dbPath,
      id: teamFlow.id,
      name: teamFlow.name,
      flowJson: JSON.stringify(teamFlow),
      workspaceId: teamFlow.workspaceId,
      createdAt: teamFlow.createdAt
    })
  ).toMatchObject({ success: true })
  expect(
    await client.request('db/sync-capture-local', { dbPath, providerId: 'webdav' })
  ).toMatchObject({
    success: false,
    error: 'LEGACY_SYNC_TEAM_WORKSPACE_UNSUPPORTED'
  })
  expect(
    await client.request('db/sync-apply-db-merge', {
      dbPath,
      recordsToApply: [],
      recordsToDelete: []
    })
  ).toMatchObject({ success: false, error: 'LEGACY_SYNC_TEAM_WORKSPACE_UNSUPPORTED' })
})
