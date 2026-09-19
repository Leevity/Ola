import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import { canaryListDrawRuns, closeLegacyReadCanary } from '../../src/main/db/legacy-read-canary'
import type { DrawRunRow } from '../../src/main/db/draw-runs-dao'

const cleanup: Array<() => Promise<void>> = []
const originalPath = process.env.OLA_TS_LEGACY_READ_PATH
const originalEnabled = process.env.OLA_TS_DRAW_RUN_READS

afterEach(async () => {
  await closeLegacyReadCanary()
  if (originalPath === undefined) delete process.env.OLA_TS_LEGACY_READ_PATH
  else process.env.OLA_TS_LEGACY_READ_PATH = originalPath
  if (originalEnabled === undefined) delete process.env.OLA_TS_DRAW_RUN_READS
  else process.env.OLA_TS_DRAW_RUN_READS = originalEnabled
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('matches Native Draw rows and excludes other workspaces on a real database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-draw-read-parity-'))
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
  for (const run of [
    { id: 'personal-draw', workspaceId: 'local-personal', createdAt: 1 },
    { id: 'team-old', workspaceId: 'team-a', createdAt: 2 },
    { id: 'team-new', workspaceId: 'team-a', createdAt: 3 },
    { id: 'foreign-draw', workspaceId: 'team-b', createdAt: 4 }
  ]) {
    expect(
      (
        await client.request('db/draw-runs-save', {
          dbPath,
          ...run,
          prompt: run.id,
          providerName: 'Provider',
          modelName: 'Model',
          mode: 'image',
          metaJson: JSON.stringify({ id: run.id }),
          isGenerating: run.id === 'team-new',
          imagesJson: '[]',
          updatedAt: run.createdAt
        })
      ).success
    ).toBe(true)
  }
  const reader = new LegacyReadRepository(dbPath)
  cleanup.push(() => reader.close())
  for (const workspaceId of ['local-personal', 'team-a', 'team-b']) {
    const native = await client.request('db/draw-runs-list', { dbPath, workspaceId })
    expect(await reader.drawRuns<DrawRunRow>(workspaceId)).toEqual(native)
  }
  expect((await reader.drawRuns<DrawRunRow>('team-a')).map((row) => row.id)).toEqual([
    'team-new',
    'team-old'
  ])

  process.env.OLA_TS_LEGACY_READ_PATH = dbPath
  delete process.env.OLA_TS_DRAW_RUN_READS
  expect(await canaryListDrawRuns('team-a')).toEqual(
    await client.request('db/draw-runs-list', { dbPath, workspaceId: 'team-a' })
  )
  process.env.OLA_TS_DRAW_RUN_READS = '0'
  expect(await canaryListDrawRuns('team-a')).toBeUndefined()
})
