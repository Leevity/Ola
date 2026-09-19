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

it('preserves Native sub-agent migration markers and continues idempotent writes in TS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-sub-agent-migration-handover-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const { client, child } = await startWorker(directory)
  let nativeStopped = false
  const stopNative = async (): Promise<void> => {
    if (nativeStopped) return
    nativeStopped = true
    client.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
  cleanup.push(stopNative)
  const dbPath = join(directory, 'data.db')
  expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
  const key = 'sub_agent_history.bootstrap.v1'
  const missing = await client.request('db/sub-agent-history-migration-status', { dbPath, key })
  expect(missing).toEqual({ applied: false })
  expect(
    await client.request('db/sub-agent-history-migration-mark', {
      dbPath,
      key,
      appliedAt: 1234
    })
  ).toMatchObject({ success: true, changed: 1 })
  const nativeStatus = await client.request('db/sub-agent-history-migration-status', {
    dbPath,
    key
  })
  expect(nativeStatus).toMatchObject({ applied: true, appliedAt: 1234 })
  await stopNative()

  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    sourcePath: dbPath,
    backupDirectory: join(directory, 'backups'),
    requireQuiescedSource: true
  })
  expect(snapshot.tables).toContain('app_migrations')
  const repository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  try {
    expect(await repository.subAgentHistoryMigrationStatus(key)).toEqual(nativeStatus)
    expect(await repository.markSubAgentHistoryMigration(key, 5678)).toBe(0)
    expect(await repository.subAgentHistoryMigrationStatus(key)).toEqual(nativeStatus)
    expect(await repository.subAgentHistoryMigrationStatus('another-key')).toEqual({
      applied: false
    })
    expect(await repository.markSubAgentHistoryMigration('another-key', 5678)).toBe(1)
  } finally {
    await repository.close()
  }

  const reopened = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  try {
    expect(await reopened.subAgentHistoryMigrationStatus(key)).toEqual(nativeStatus)
    expect(await reopened.subAgentHistoryMigrationStatus('another-key')).toEqual({
      applied: true,
      appliedAt: 5678
    })
  } finally {
    await reopened.close()
  }
})
