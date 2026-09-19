import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import {
  canaryLookupRuntimeToolResults,
  closeLegacyReadCanary
} from '../../src/main/db/legacy-read-canary'

const cleanup: Array<() => Promise<void>> = []
const originalPath = process.env.OLA_TS_LEGACY_READ_PATH
const originalEnabled = process.env.OLA_TS_TOOL_RESULT_READS

afterEach(async () => {
  await closeLegacyReadCanary()
  if (originalPath === undefined) delete process.env.OLA_TS_LEGACY_READ_PATH
  else process.env.OLA_TS_LEGACY_READ_PATH = originalPath
  if (originalEnabled === undefined) delete process.env.OLA_TS_TOOL_RESULT_READS
  else process.env.OLA_TS_TOOL_RESULT_READS = originalEnabled
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('matches Native persisted tool-result lookup on a real database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-tool-result-read-parity-'))
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
  for (const [id, workspaceId] of [
    ['personal', 'local-personal'],
    ['team', 'team-a'],
    ['foreign', 'team-b']
  ]) {
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id,
          title: id,
          mode: 'chat',
          workspaceId
        })
      ).success
    ).toBe(true)
  }
  const db = new DatabaseSync(dbPath)
  try {
    const insert = db.prepare(
      `INSERT INTO runtime_tool_results
        (session_id,tool_use_id,run_id,tool_name,status,content_json,is_error,started_at,completed_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    for (const sessionId of ['personal', 'team', 'foreign']) {
      insert.run(
        sessionId,
        'first',
        `${sessionId}-run`,
        'Read',
        'completed',
        JSON.stringify({ type: 'text', text: sessionId }),
        0,
        null,
        20
      )
      insert.run(
        sessionId,
        'second',
        `${sessionId}-run`,
        'Bash',
        'failed',
        JSON.stringify([{ type: 'text', text: 'failed' }]),
        1,
        10,
        10
      )
    }
  } finally {
    db.close()
  }
  const reader = new LegacyReadRepository(dbPath)
  cleanup.push(() => reader.close())
  for (const [sessionId, workspaceId] of [
    ['personal', 'local-personal'],
    ['team', 'team-a'],
    ['foreign', 'team-b']
  ]) {
    for (const toolUseIds of [
      ['first', 'second', 'first', '', 'missing'],
      [' missing ', ' second '],
      [],
      [...Array.from({ length: 256 }, (_, n) => `missing-${n}`), 'first']
    ]) {
      expect(await reader.runtimeToolResults({ sessionId, workspaceId, toolUseIds })).toEqual(
        await client.request('agent/tool-results-lookup', {
          dbPath,
          sessionId,
          workspaceId,
          toolUseIds
        })
      )
    }
  }
  await expect(
    reader.runtimeToolResults({
      sessionId: 'team',
      workspaceId: 'local-personal',
      toolUseIds: ['first']
    })
  ).rejects.toThrow('TOOL_RESULT_SESSION_WORKSPACE_MISMATCH')

  process.env.OLA_TS_LEGACY_READ_PATH = dbPath
  delete process.env.OLA_TS_TOOL_RESULT_READS
  expect(
    await canaryLookupRuntimeToolResults({
      sessionId: 'team',
      workspaceId: 'team-a',
      toolUseIds: ['first', 'second']
    })
  ).toEqual(
    await client.request('agent/tool-results-lookup', {
      dbPath,
      sessionId: 'team',
      workspaceId: 'team-a',
      toolUseIds: ['first', 'second']
    })
  )
  process.env.OLA_TS_TOOL_RESULT_READS = '0'
  expect(
    await canaryLookupRuntimeToolResults({
      sessionId: 'team',
      workspaceId: 'team-a',
      toolUseIds: ['first']
    })
  ).toBeUndefined()
})
