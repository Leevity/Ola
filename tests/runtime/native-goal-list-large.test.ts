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

it('does not truncate the default TS Goal list at the pagination default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-goal-list-large-'))
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
  for (let index = 0; index < 205; index += 1) {
    const id = `team-session-${index}`
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id,
          title: id,
          mode: 'chat',
          workspaceId: 'team-a'
        })
      ).success
    ).toBe(true)
    expect(
      (await client.request('db/goals-create', { dbPath, sessionId: id, objective: id })).success
    ).toBe(true)
  }
  expect(
    (
      await client.request('db/sessions-create', {
        dbPath,
        id: 'other-session',
        title: 'Other',
        mode: 'chat',
        workspaceId: 'team-b'
      })
    ).success
  ).toBe(true)
  expect(
    (
      await client.request('db/goals-create', {
        dbPath,
        sessionId: 'other-session',
        objective: 'Other'
      })
    ).success
  ).toBe(true)
  const nativeRows = (await client.request('db/goals-list', {
    dbPath,
    workspaceId: 'team-a'
  })) as Array<{ session_id: string }>
  expect(nativeRows).toHaveLength(205)
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backup')
  })
  const repository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  cleanup.push(() => repository.close())
  const tsRows = await repository.goals<{ session_id: string }>('team-a')
  expect(tsRows).toHaveLength(205)
  expect(tsRows.map((row) => row.session_id).sort()).toEqual(
    nativeRows.map((row) => row.session_id).sort()
  )
  expect(await repository.goals('team-b')).toHaveLength(1)
  expect(await repository.goals('team-a', 20, 10)).toHaveLength(20)
}, 60_000)
