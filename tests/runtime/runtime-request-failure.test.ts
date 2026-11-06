import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeClient } from '../../src/runtime/host/runtime-client'
import { RuntimeServer } from '../../src/runtime/host/runtime-server'
import { RunScheduler } from '../../src/runtime/scheduler/run-scheduler'
import { RunJournal } from '../../src/runtime/storage/run-journal'
import { ModelBindingError } from '../../src/shared/runtime/model-source'

const TOKEN = 'a'.repeat(64)

describe('runtime request failures', () => {
  let dir: string
  let journal: RunJournal
  let scheduler: RunScheduler
  let server: RuntimeServer | null = null
  let client: RuntimeClient | null = null

  /** One socket per behavior, because a failed request may close an unauthenticated socket. */
  async function serve(workspaceIds: () => Promise<Set<string>>, name: string): Promise<void> {
    client?.close()
    await server?.close()
    server = new RuntimeServer(scheduler, TOKEN, { workspaceIds })
    await server.listen(join(dir, name))
    client = new RuntimeClient()
    await client.connect(join(dir, name), TOKEN, ['runs', 'replay'])
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ola-request-failure-'))
    journal = new RunJournal(join(dir, 'db'))
    scheduler = new RunScheduler(
      journal,
      async () => undefined,
      async () => undefined
    )
    await scheduler.initialize()
  })

  afterAll(async () => {
    client?.close()
    await server?.close()
    await scheduler.stop()
    await journal.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('names a model binding failure instead of the generic token', async () => {
    await serve(async () => {
      throw new ModelBindingError('ACCOUNT_UNAVAILABLE')
    }, 'binding')
    await expect(client!.request('run.list', { workspaceId: 'local-personal' })).rejects.toThrow(
      'ACCOUNT_UNAVAILABLE'
    )
  })

  it('keeps the generic token for an unknown failure but logs its cause', async () => {
    const error = new TypeError('fetch failed')
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await serve(async () => {
        throw error
      }, 'unknown')
      await expect(client!.request('run.list', { workspaceId: 'local-personal' })).rejects.toThrow(
        'REQUEST_FAILED'
      )
      expect(log).toHaveBeenCalledWith('[TsRuntime] request failed', {
        method: 'run.list',
        error
      })
    } finally {
      log.mockRestore()
    }
  })

  it('leaves a permitted request unaffected by the failure path', async () => {
    await serve(async () => new Set(['local-personal']), 'permitted')
    await expect(client!.request('run.list', { workspaceId: 'team-secret' })).rejects.toThrow(
      'WORKSPACE_FORBIDDEN'
    )
    expect(await client!.request('run.list', { workspaceId: 'local-personal' })).toBeDefined()
  })
})
