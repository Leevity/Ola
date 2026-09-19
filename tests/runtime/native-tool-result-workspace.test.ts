import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('Native runtime tool result workspace boundary', () => {
  it('rejects cross-space lookup even with a valid session and tool ID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-tool-result-workspace-'))
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
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id: 'team-session',
          title: 'Team',
          mode: 'chat',
          workspaceId: 'team-a'
        })
      ).success
    ).toBe(true)
    const database = new DatabaseSync(dbPath)
    try {
      database
        .prepare(
          `INSERT INTO runtime_tool_results (
        session_id,tool_use_id,run_id,tool_name,status,content_json,completed_at
      ) VALUES (?,?,?,?,?,?,?)`
        )
        .run('team-session', 'tool-a', 'run-a', 'Read', 'completed', '{"secret":"team"}', 1000)
    } finally {
      database.close()
    }
    expect(
      await client.request('agent/tool-results-lookup', {
        dbPath,
        sessionId: 'team-session',
        workspaceId: 'local-personal',
        toolUseIds: ['tool-a']
      })
    ).toMatchObject({ error: expect.stringContaining('another workspace') })
    expect(
      await client.request('agent/tool-results-lookup', {
        dbPath,
        sessionId: 'team-session',
        workspaceId: 'team-a',
        toolUseIds: ['tool-a']
      })
    ).toEqual([expect.objectContaining({ content: { secret: 'team' } })])
  }, 30_000)
})
