import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FrameDecoder, encodeFrame } from '../../src/runtime/host/framing'
import { RuntimeClient } from '../../src/runtime/host/runtime-client'
import { RuntimeServer } from '../../src/runtime/host/runtime-server'
import { RunScheduler } from '../../src/runtime/scheduler/run-scheduler'
import { RunJournal } from '../../src/runtime/storage/run-journal'
import type { RunSnapshot } from '../../src/shared/runtime/contracts'

describe('local service transport', () => {
  it('handles split UTF8 frames and rejects oversized lengths before allocation', () => {
    const decoder = new FrameDecoder(),
      value = { text: '你好🌍' }
    const encoded = encodeFrame(value),
      received: unknown[] = []
    for (const byte of encoded) received.push(...decoder.push(Buffer.from([byte])))
    expect(received).toEqual([value])
    expect(() => new FrameDecoder().push(Buffer.from([255, 255, 255, 255]))).toThrow(
      'INVALID_FRAME_LENGTH'
    )
  })
  it('requires authentication and keeps running after all clients disconnect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ola-transport-'))
    const endpoint =
      process.platform === 'win32' ? `\\\\.\\pipe\\ola-test-${randomUUID()}` : join(dir, 's')
    const journal = new RunJournal(join(dir, 'db'))
    const scheduler = new RunScheduler(
      journal,
      async (_run, context) => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        await context.emit('message.delta', { text: 'survived' })
      },
      async () => undefined
    )
    const token = 'a'.repeat(64)
    const server = new RuntimeServer(scheduler, token, {
      workspaceIds: async () => new Set(['local-personal'])
    })
    const client = new RuntimeClient(),
      another = new RuntimeClient(),
      bad = new RuntimeClient()
    try {
      await scheduler.initialize()
      await server.listen(endpoint)
      await expect(bad.connect(endpoint, 'wrong')).rejects.toThrow('HANDSHAKE_REJECTED')
      await client.connect(endpoint, token)
      await expect(client.request('run.list', { workspaceId: 'team-b' })).rejects.toThrow(
        'WORKSPACE_FORBIDDEN'
      )
      await client.request('run.submit', {
        runId: 'r',
        taskId: 't',
        requestId: 'q',
        traceId: 't',
        sessionId: 's',
        workspaceId: 'local-personal',
        environmentId: 'local',
        modelSource: { kind: 'local', providerId: 'p', modelId: 'm' },
        prompt: 'hi',
        unattended: true
      })
      client.close()
      await another.connect(endpoint, token)
      await expect
        .poll(
          async () =>
            (
              await another.request<RunSnapshot>('run.snapshot', {
                workspaceId: 'local-personal',
                runId: 'r'
              })
            ).run.status
        )
        .toBe('completed')
      const snapshot = await another.request<RunSnapshot>('run.snapshot', {
        workspaceId: 'local-personal',
        runId: 'r',
        afterSeq: 2
      })
      expect(snapshot.events[0].data).toEqual({ text: 'survived' })
    } finally {
      client.close()
      another.close()
      bad.close()
      await server.close()
      await scheduler.stop()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('does not return run history if workspace access is revoked during the read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ola-revoked-history-'))
    const endpoint =
      process.platform === 'win32' ? `\\\\.\\pipe\\ola-revoked-${randomUUID()}` : join(dir, 's')
    const journal = new RunJournal(join(dir, 'db'))
    const scheduler = new RunScheduler(
      journal,
      async () => undefined,
      async () => undefined
    )
    let allowed = true
    const server = new RuntimeServer(scheduler, 'r'.repeat(64), {
      workspaceIds: async () => new Set(allowed ? ['team-a'] : [])
    })
    const client = new RuntimeClient()
    try {
      await scheduler.initialize()
      await server.listen(endpoint)
      await client.connect(endpoint, 'r'.repeat(64))
      vi.spyOn(journal, 'list').mockImplementation(async () => {
        allowed = false
        return []
      })
      await expect(client.request('run.list', { workspaceId: 'team-a' })).rejects.toThrow(
        'WORKSPACE_FORBIDDEN'
      )
      allowed = true
      vi.spyOn(journal, 'snapshot').mockImplementation(async () => {
        allowed = false
        return null
      })
      await expect(
        client.request('run.snapshot', { workspaceId: 'team-a', runId: 'run-a' })
      ).rejects.toThrow('WORKSPACE_FORBIDDEN')
    } finally {
      client.close()
      await server.close()
      await scheduler.stop()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('negotiates only capabilities supported by both local endpoints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ola-capability-transport-'))
    const endpoint =
      process.platform === 'win32' ? `\\\\.\\pipe\\ola-capability-${randomUUID()}` : join(dir, 's')
    const journal = new RunJournal(join(dir, 'db'))
    const scheduler = new RunScheduler(
      journal,
      async () => undefined,
      async () => undefined
    )
    const server = new RuntimeServer(
      scheduler,
      'c'.repeat(64),
      { workspaceIds: async () => new Set(['local-personal']) },
      { capabilities: ['runs', 'replay'] }
    )
    const client = new RuntimeClient()
    try {
      await scheduler.initialize()
      await server.listen(endpoint)
      await client.connect(endpoint, 'c'.repeat(64), ['runs', 'cancel'])
      expect([...client.capabilities]).toEqual(['runs'])
      await expect(
        client.request('run.cancel', { workspaceId: 'local-personal', runId: 'unknown' })
      ).rejects.toThrow('CAPABILITY_UNAVAILABLE')
    } finally {
      client.close()
      await server.close()
      await scheduler.stop()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('rejects a workspace switch while an authenticated client has active work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ola-workspace-switch-transport-'))
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\ola-workspace-switch-${randomUUID()}`
        : join(dir, 's')
    const journal = new RunJournal(join(dir, 'db'))
    const scheduler = new RunScheduler(
      journal,
      async (_run, { signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      async () => undefined
    )
    const token = 'w'.repeat(64)
    const server = new RuntimeServer(scheduler, token, {
      workspaceIds: async () => new Set(['local-personal', 'team-a'])
    })
    const client = new RuntimeClient()
    try {
      await scheduler.initialize()
      await server.listen(endpoint)
      await client.connect(endpoint, token)
      await client.request('run.submit', {
        runId: 'busy',
        taskId: 'task',
        requestId: 'request',
        traceId: 'trace',
        sessionId: 'session',
        workspaceId: 'local-personal',
        environmentId: 'local',
        modelSource: { kind: 'local', providerId: 'p', modelId: 'm' },
        prompt: 'wait',
        unattended: true
      })
      await expect(client.request('workspace.switch', { workspaceId: 'team-a' })).rejects.toThrow(
        'WORKSPACE_BUSY'
      )
      await client.request('run.cancel', { workspaceId: 'local-personal', runId: 'busy' })
      await expect
        .poll(async () => {
          try {
            await client.request('workspace.switch', { workspaceId: 'team-a' })
            return true
          } catch {
            return false
          }
        })
        .toBe(true)
    } finally {
      client.close()
      await server.close()
      await scheduler.stop()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('routes a persisted interaction response through the authenticated local service', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ola-interaction-transport-'))
    const endpoint =
      process.platform === 'win32' ? `\\\\.\\pipe\\ola-interaction-${randomUUID()}` : join(dir, 's')
    const journal = new RunJournal(join(dir, 'db'))
    const scheduler = new RunScheduler(
      journal,
      async (_run, context) => {
        const answer = await context.requestInteraction({
          interactionId: 'approve',
          kind: 'plan-approval',
          payload: { version: 2 },
          version: '2'
        })
        await context.emit('answer', answer)
      },
      async () => undefined
    )
    const token = 'b'.repeat(64)
    const server = new RuntimeServer(scheduler, token, {
      workspaceIds: async () => new Set(['local-personal'])
    })
    const client = new RuntimeClient()
    try {
      await scheduler.initialize()
      await server.listen(endpoint)
      await client.connect(endpoint, token)
      await client.request('run.submit', {
        runId: 'interactive',
        taskId: 'task',
        requestId: 'request',
        traceId: 'trace',
        sessionId: 'session',
        workspaceId: 'local-personal',
        environmentId: 'local',
        modelSource: { kind: 'local', providerId: 'p', modelId: 'm' },
        prompt: 'approve?',
        unattended: false
      })
      await expect
        .poll(
          async () =>
            (
              await client.request<RunSnapshot>('run.snapshot', {
                workspaceId: 'local-personal',
                runId: 'interactive'
              })
            ).run.status
        )
        .toBe('waiting_interaction')
      const pending = await client.request<RunSnapshot>('run.snapshot', {
        workspaceId: 'local-personal',
        runId: 'interactive'
      })
      expect(pending.pendingInteractions).toEqual([
        expect.objectContaining({ interactionId: 'approve', version: '2' })
      ])
      await client.request('run.interact', {
        workspaceId: 'local-personal',
        runId: 'interactive',
        interactionId: 'approve',
        response: { approved: true }
      })
      await expect
        .poll(
          async () =>
            (
              await client.request<RunSnapshot>('run.snapshot', {
                workspaceId: 'local-personal',
                runId: 'interactive'
              })
            ).run.status
        )
        .toBe('completed')
    } finally {
      client.close()
      await server.close()
      await scheduler.stop()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
