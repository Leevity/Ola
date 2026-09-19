import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import {
  canaryGetMemoryAutomationEntry,
  canaryListMemoryAutomationEntries,
  closeLegacyReadCanary
} from '../../src/main/db/legacy-read-canary'
import type {
  MemoryAutomationEntry,
  MemoryAutomationListQuery
} from '../../src/shared/memory-automation-types'

const cleanup: Array<() => Promise<void>> = []
const originalPath = process.env.OLA_TS_LEGACY_READ_PATH
const originalEnabled = process.env.OLA_TS_MEMORY_ROOT_READS

afterEach(async () => {
  await closeLegacyReadCanary()
  if (originalPath === undefined) delete process.env.OLA_TS_LEGACY_READ_PATH
  else process.env.OLA_TS_LEGACY_READ_PATH = originalPath
  if (originalEnabled === undefined) delete process.env.OLA_TS_MEMORY_ROOT_READS
  else process.env.OLA_TS_MEMORY_ROOT_READS = originalEnabled
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('matches Native automation entry projection, filters, snapshots, and workspace scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-memory-automation-read-'))
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
  const root = (await client.request('db/memory-roots-ensure', {
    dbPath,
    workspaceId: 'team-a',
    scope: 'global',
    rootPath: join(directory, 'team')
  })) as { id: string }
  expect(root.id).toBeTypeOf('string')
  const entries: MemoryAutomationEntry[] = []
  for (const input of [
    {
      workspaceId: 'local-personal',
      target: 'global_user',
      status: 'written',
      fingerprint: 'personal',
      targetPath: '/memory/personal.md'
    },
    {
      workspaceId: 'team-a',
      memoryRootId: root.id,
      rootScope: 'global',
      target: 'global_memory',
      status: 'written',
      fingerprint: 'team-written',
      targetPath: '/memory/team.md',
      beforeContent: 'before',
      afterContent: 'after',
      appendedText: 'append'
    },
    {
      workspaceId: 'team-a',
      memoryRootId: root.id,
      rootScope: 'global',
      target: 'global_memory',
      status: 'filtered',
      fingerprint: 'team-filtered',
      targetPath: '/memory/team.md'
    }
  ]) {
    const result = (await client.request('db/memory-automation-add', {
      dbPath,
      scope: 'main',
      kind: 'user_preference',
      content: input.fingerprint,
      confidence: 0.8,
      ...input
    })) as { success: boolean; entry: MemoryAutomationEntry }
    expect(result.success).toBe(true)
    entries.push(result.entry)
  }
  const reader = new LegacyReadRepository(dbPath)
  cleanup.push(() => reader.close())
  const queries: Array<MemoryAutomationListQuery & { workspaceId: string }> = [
    { workspaceId: 'local-personal' },
    { workspaceId: 'team-a' },
    { workspaceId: 'team-b' },
    { workspaceId: 'team-a', statuses: ['written'] },
    { workspaceId: 'team-a', targets: ['global_memory'], targetPathIncludes: 'team' },
    { workspaceId: 'team-a', targetPathIncludes: ' team' },
    { workspaceId: 'team-a', targetPath: ' /memory/team.md' },
    { workspaceId: 'team-a', memoryRootId: root.id, rootScope: 'global' },
    { workspaceId: 'team-a', fingerprint: 'team-filtered', limit: 1, offset: 0 },
    { workspaceId: 'team-a', includeContentSnapshots: true }
  ]
  for (const query of queries) {
    expect(await reader.memoryAutomationEntries(query)).toEqual(
      await client.request('db/memory-automation-list', { dbPath, ...query })
    )
  }
  expect(await reader.memoryAutomationEntry(entries[1].id, 'team-a')).toEqual(
    (
      (await client.request('db/memory-automation-get', {
        dbPath,
        id: entries[1].id,
        workspaceId: 'team-a'
      })) as { entry: MemoryAutomationEntry }
    ).entry
  )
  expect(await reader.memoryAutomationEntry(entries[1].id, 'local-personal')).toBeNull()

  process.env.OLA_TS_LEGACY_READ_PATH = dbPath
  delete process.env.OLA_TS_MEMORY_ROOT_READS
  expect(await canaryListMemoryAutomationEntries(queries[1])).toEqual(
    await reader.memoryAutomationEntries(queries[1])
  )
  expect(await canaryGetMemoryAutomationEntry(entries[1].id, 'team-a')).toEqual(entries[1])
  process.env.OLA_TS_MEMORY_ROOT_READS = '0'
  expect(await canaryListMemoryAutomationEntries(queries[1])).toBeUndefined()
  expect(await canaryGetMemoryAutomationEntry(entries[1].id, 'team-a')).toBeUndefined()
})
