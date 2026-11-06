import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RuntimeClient } from '../../src/runtime/host/runtime-client'
import { RuntimeServer } from '../../src/runtime/host/runtime-server'
import { RunScheduler } from '../../src/runtime/scheduler/run-scheduler'
import { RunJournal } from '../../src/runtime/storage/run-journal'
import type { RunEvent } from '../../src/shared/runtime/contracts'

const TOKEN = 'a'.repeat(64)

function endpointFor(directory: string, name: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\ola-${name}-${randomUUID()}`
    : join(directory, 's')
}

function spec(runId: string, workspaceId: string): Record<string, unknown> {
  return {
    runId,
    taskId: `task-${runId}`,
    requestId: `request-${runId}`,
    traceId: `trace-${runId}`,
    sessionId: `session-${runId}`,
    workspaceId,
    environmentId: 'local',
    modelSource: { kind: 'local', providerId: 'p', modelId: 'm' },
    prompt: 'go',
    unattended: true
  }
}

describe('run subscription authorization', () => {
  it('refuses a subscription for a workspace the caller cannot see', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ola-push-auth-'))
    const endpoint = endpointFor(dir, 'push-auth')
    const journal = new RunJournal(join(dir, 'db'))
    const scheduler = new RunScheduler(
      journal,
      async (_run, context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      async () => undefined
    )
    const server = new RuntimeServer(scheduler, TOKEN, {
      workspaceIds: async () => new Set(['local-personal'])
    })
    const client = new RuntimeClient()
    try {
      await scheduler.initialize()
      await server.listen(endpoint)
      await client.connect(endpoint, TOKEN)
      await expect(
        client.request('run.subscribe', {
          workspaceId: 'team-secret',
          runId: 'anything',
          afterSeq: 0
        })
      ).rejects.toThrow('WORKSPACE_FORBIDDEN')
      await expect(
        client.request('run.subscribe', {
          workspaceId: 'local-personal',
          runId: 'missing',
          afterSeq: 0
        })
      ).rejects.toThrow('RUN_NOT_FOUND')
    } finally {
      client.close()
      await server.close()
      await scheduler.stop()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stops pushing once the workspace is revoked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ola-push-revoke-'))
    const endpoint = endpointFor(dir, 'push-revoke')
    const journal = new RunJournal(join(dir, 'db'))
    const allowed = new Set(['local-personal'])
    let emit: ((type: string, data: unknown) => Promise<void>) | null = null
    const scheduler = new RunScheduler(
      journal,
      async (_run, context) => {
        emit = context.emit
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      async () => undefined
    )
    const server = new RuntimeServer(scheduler, TOKEN, { workspaceIds: async () => allowed })
    const client = new RuntimeClient()
    const pushed: RunEvent[] = []
    const resyncReasons: string[] = []
    try {
      await scheduler.initialize()
      await server.listen(endpoint)
      await client.connect(endpoint, TOKEN)
      await client.request('run.submit', spec('revoked', 'local-personal'))
      await expect.poll(async () => (emit ? true : false), { timeout: 5000 }).toBe(true)
      const stream = await client.openRunStream({
        workspaceId: 'local-personal',
        runId: 'revoked',
        afterSeq: 0,
        onEvent: (event) => pushed.push(event),
        onResync: (reason) => resyncReasons.push(reason)
      })
      await emit!('message.delta', { text: 'before' })
      await expect.poll(async () => pushed.length, { timeout: 5000 }).toBeGreaterThan(0)
      const beforeRevoke = pushed.length
      // Revocation must stop frames, not just future subscriptions.
      allowed.clear()
      server.revokeUnavailableWorkspaces(new Set())
      await emit!('message.delta', { text: 'after' }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(pushed).toHaveLength(beforeRevoke)
      // The resync frame is what releases the consumer; dropping the subscription silently
      // would leave a waiting run stream stalled on a workspace that can never push again.
      expect(resyncReasons).toEqual(['WORKSPACE_REVOKED'])
      // The socket is still usable for a permitted workspace.
      allowed.add('local-personal')
      await client.request('ping', {})
      await stream.close()
    } finally {
      client.close()
      await server.close()
      await scheduler.stop()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
