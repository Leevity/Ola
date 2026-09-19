import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { createLegacyDatabaseHandoverSnapshot } from '../../src/runtime/storage/legacy-database-handover'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import {
  canaryResolveQqWakeupEligibility,
  closeLegacyReadCanary
} from '../../src/main/db/legacy-read-canary'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('QQ wakeup windows across workspaces and the TS handover', () => {
  it('backfills old local windows and keeps equal QQ identities isolated in Native and TS', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-ts-qq-wakeup-'))
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
    const nativeDb = new DatabaseSync(dbPath)
    nativeDb
      .prepare(
        `INSERT INTO qq_wakeup_windows
      (plugin_id,open_id,period_key,source_message_id,source_timestamp,sent_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('shared-plugin', 'shared-open-id', 'day-0', null, 100, 110, 110, 110)
    nativeDb.close()
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)

    const localInput = {
      dbPath,
      pluginId: 'shared-plugin',
      openId: 'shared-open-id',
      workspaceId: 'local-personal',
      now: 200
    }
    const teamInput = { ...localInput, workspaceId: 'team-a' }
    expect(await client.request('db/qq-wakeup-resolve', localInput)).toMatchObject({
      success: true,
      enabled: false,
      periodKey: 'day-0'
    })
    expect(await client.request('db/qq-wakeup-resolve', teamInput)).toMatchObject({
      success: true,
      enabled: true,
      periodKey: 'day-0'
    })
    const nativeSource = {
      ...teamInput,
      sourceMessageId: 'latest-native',
      sourceTimestamp: 180
    }
    expect(await client.request('db/qq-wakeup-record-source', nativeSource)).toMatchObject({
      success: true,
      changed: 1
    })
    expect(
      await client.request('db/qq-wakeup-record-source', {
        ...nativeSource,
        sourceMessageId: 'stale-native',
        sourceTimestamp: 150
      })
    ).toMatchObject({ success: true, changed: 0 })
    expect(await client.request('db/qq-wakeup-resolve', teamInput)).toMatchObject({
      sourceMessageId: 'latest-native',
      sourceTimestamp: 180
    })
    expect(await client.request('db/qq-wakeup-resolve', localInput)).toMatchObject({
      sourceTimestamp: 200
    })
    const reader = new LegacyReadRepository(dbPath)
    cleanup.push(() => reader.close())
    const { dbPath: _readPath, ...teamRead } = teamInput
    const { dbPath: _localReadPath, ...localRead } = localInput
    expect(await reader.qqWakeupEligibility(teamRead)).toMatchObject({
      enabled: true,
      periodKey: 'day-0',
      sourceMessageId: 'latest-native',
      sourceTimestamp: 180
    })
    expect(await reader.qqWakeupEligibility(localRead)).toMatchObject({
      enabled: false,
      periodKey: 'day-0',
      sourceMessageId: null,
      sourceTimestamp: 200
    })
    const day = 24 * 60 * 60 * 1000
    for (const [now, periodKey] of [
      [179, null],
      [180, 'day-0'],
      [180 + day - 1, 'day-0'],
      [180 + day, 'day-1-3'],
      [180 + 3 * day, 'day-3-7'],
      [180 + 7 * day, 'day-7-30'],
      [180 + 30 * day, null]
    ] as Array<[number, string | null]>) {
      const input = { ...teamRead, now }
      const native = await client.request('db/qq-wakeup-resolve', { ...input, dbPath })
      const ts = await reader.qqWakeupEligibility(input)
      expect(ts.periodKey).toBe(periodKey)
      expect(native.success).toBe(true)
      expect({
        enabled: native.enabled,
        periodKey: native.periodKey ?? null,
        sourceMessageId: native.sourceMessageId ?? null,
        sourceTimestamp: native.sourceTimestamp
      }).toEqual(ts)
    }
    expect(
      await client.request('db/qq-wakeup-mark-sent', {
        ...teamInput,
        periodKey: 'day-1-3',
        sourceMessageId: 'latest-native',
        sourceTimestamp: 180,
        now: 180 + day
      })
    ).toMatchObject({ success: true, changed: 1 })
    const sentWindow = { ...teamRead, now: 180 + day }
    expect(await reader.qqWakeupEligibility(sentWindow)).toMatchObject({
      enabled: false,
      periodKey: 'day-1-3'
    })
    const previousFlag = process.env.OLA_TS_LEGACY_READS
    const previousQqFlag = process.env.OLA_TS_QQ_WAKEUP_READS
    const previousPath = process.env.OLA_TS_LEGACY_READ_PATH
    process.env.OLA_TS_LEGACY_READS = '1'
    process.env.OLA_TS_LEGACY_READ_PATH = dbPath
    cleanup.push(async () => {
      await closeLegacyReadCanary()
      if (previousFlag === undefined) delete process.env.OLA_TS_LEGACY_READS
      else process.env.OLA_TS_LEGACY_READS = previousFlag
      if (previousQqFlag === undefined) delete process.env.OLA_TS_QQ_WAKEUP_READS
      else process.env.OLA_TS_QQ_WAKEUP_READS = previousQqFlag
      if (previousPath === undefined) delete process.env.OLA_TS_LEGACY_READ_PATH
      else process.env.OLA_TS_LEGACY_READ_PATH = previousPath
    })
    expect(await canaryResolveQqWakeupEligibility(teamRead)).toEqual(
      await reader.qqWakeupEligibility(teamRead)
    )
    expect(await canaryResolveQqWakeupEligibility(localRead)).toEqual(
      await reader.qqWakeupEligibility(localRead)
    )
    delete process.env.OLA_TS_LEGACY_READS
    delete process.env.OLA_TS_QQ_WAKEUP_READS
    expect(await canaryResolveQqWakeupEligibility(teamRead)).toEqual(
      await reader.qqWakeupEligibility(teamRead)
    )
    process.env.OLA_TS_QQ_WAKEUP_READS = '0'
    await expect(canaryResolveQqWakeupEligibility(teamRead)).resolves.toBeUndefined()
    delete process.env.OLA_TS_QQ_WAKEUP_READS

    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      sourcePath: dbPath,
      backupDirectory: join(directory, 'backups')
    })
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    cleanup.push(() => repository.close())
    const { dbPath: _dbPath, ...local } = localInput
    const { dbPath: _teamDbPath, ...team } = teamInput
    expect(await repository.resolveQqWakeupEligibility(local)).toMatchObject({
      enabled: false,
      periodKey: 'day-0'
    })
    expect(await repository.resolveQqWakeupEligibility(team)).toMatchObject({
      enabled: true,
      periodKey: 'day-0',
      sourceMessageId: 'latest-native',
      sourceTimestamp: 180
    })
    expect(
      await repository.markQqWakeupSent({
        ...team,
        periodKey: 'day-0',
        sourceMessageId: null,
        sourceTimestamp: 200
      })
    ).toBe(1)
    expect(await repository.resolveQqWakeupEligibility(team)).toMatchObject({ enabled: false })
    expect(await repository.resolveQqWakeupEligibility(local)).toMatchObject({ enabled: false })
    const teamSource = {
      ...team,
      sourceMessageId: 'team-source',
      sourceTimestamp: 190
    }
    expect(await repository.recordQqWakeupSource(teamSource)).toBe(1)
    expect(
      await repository.recordQqWakeupSource({
        ...teamSource,
        sourceMessageId: 'stale-team-source',
        sourceTimestamp: 185
      })
    ).toBe(0)
    expect(await repository.resolveQqWakeupEligibility(team)).toMatchObject({
      enabled: false,
      sourceMessageId: 'team-source',
      sourceTimestamp: 190
    })
    expect(await repository.resolveQqWakeupEligibility(local)).toMatchObject({
      sourceMessageId: null,
      sourceTimestamp: 200
    })
    await expect(
      repository.resolveQqWakeupEligibility({ ...team, workspaceId: '' })
    ).rejects.toThrow('INVALID_BUSINESS_WORKSPACE')
  })
})
