import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RuntimeClient } from '../../src/runtime/host/runtime-client'
import { RuntimeServer } from '../../src/runtime/host/runtime-server'
import { RunScheduler } from '../../src/runtime/scheduler/run-scheduler'
import { RunJournal } from '../../src/runtime/storage/run-journal'
import type { RunEvent, RunSnapshot } from '../../src/shared/runtime/contracts'

const TOKEN = 'p'.repeat(64)

function endpointFor(directory: string, name: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\ola-${name}-${randomUUID()}`
    : join(directory, 's')
}

function spec(runId: string): Record<string, unknown> {
  return {
    runId,
    taskId: `task-${runId}`,
    requestId: `request-${runId}`,
    traceId: `trace-${runId}`,
    sessionId: `session-${runId}`,
    workspaceId: 'local-personal',
    environmentId: 'local',
    modelSource: { kind: 'local', providerId: 'p', modelId: 'm' },
    prompt: 'go',
    unattended: true
  }
}

describe('run subscription stream', () => {
  it('delivers every committed event in order without duplicates or holes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ola-push-stream-'))
    const endpoint = endpointFor(dir, 'push-stream')
    const journal = new RunJournal(join(dir, 'db'))
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const scheduler = new RunScheduler(
      journal,
      async (_run, context) => {
        await context.emit('message.delta', { text: 'a' })
        await context.emit('message.delta', { text: 'b' })
        await gate
        await context.emit('message.delta', { text: 'c' })
      },
      async () => undefined
    )
    const server = new RuntimeServer(scheduler, TOKEN, {
      workspaceIds: async () => new Set(['local-personal'])
    })
    const client = new RuntimeClient()
    const pushed: RunEvent[] = []
    try {
      await scheduler.initialize()
      await server.listen(endpoint)
      await client.connect(endpoint, TOKEN)
      await client.request('run.submit', spec('streamed'))
      const streamed = await client.openRunStream({
        workspaceId: 'local-personal',
        runId: 'streamed',
        afterSeq: 0,
        onEvent: (event) => pushed.push(event),
        onResync: () => undefined
      })
      const replayed = streamed.snapshot.events.map((event) => event.seq)
      release()
      await expect
        .poll(async () => {
          const snapshot = await client.request<RunSnapshot>('run.snapshot', {
            workspaceId: 'local-personal',
            runId: 'streamed'
          })
          return snapshot.run.status
        })
        .toBe('completed')
      // One more macrotask turn so the last frame reaches the client.
      await new Promise((resolve) => setTimeout(resolve, 50))
      // The run starts after `submit` returns, so the three deltas can land in
      // the replay snapshot or arrive as pushes. Merge both sources by seq so
      // this checks delivery order instead of which channel won the race.
      const bySeq = new Map<number, RunEvent>()
      for (const event of [...streamed.snapshot.events, ...pushed]) bySeq.set(event.seq, event)
      const text = [...bySeq.values()]
        .sort((left, right) => left.seq - right.seq)
        .filter((event) => event.type === 'message.delta')
        .map((event) => (event.data as { text: string }).text)
      expect(text).toEqual(['a', 'b', 'c'])
      // Pushed events always continue the replay instead of repeating it.
      for (const event of pushed) expect(replayed).not.toContain(event.seq)
      const all = [...replayed, ...pushed.map((event) => event.seq)].sort(
        (left, right) => left - right
      )
      expect(all).toEqual(Array.from({ length: all.length }, (_value, index) => index + 1))
      await streamed.close()
    } finally {
      client.close()
      await server.close()
      await scheduler.stop()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('replays events committed before the subscription from afterSeq', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ola-push-replay-'))
    const endpoint = endpointFor(dir, 'push-replay')
    const journal = new RunJournal(join(dir, 'db'))
    const scheduler = new RunScheduler(
      journal,
      async (_run, context) => {
        await context.emit('message.delta', { text: 'one' })
        await context.emit('message.delta', { text: 'two' })
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
      await client.request('run.submit', spec('replayed'))
      await expect
        .poll(async () => {
          const snapshot = await client.request<RunSnapshot>('run.snapshot', {
            workspaceId: 'local-personal',
            runId: 'replayed'
          })
          return snapshot.run.status
        })
        .toBe('completed')
      const fromStart = await client.openRunStream({
        workspaceId: 'local-personal',
        runId: 'replayed',
        afterSeq: 0,
        onEvent: () => undefined,
        onResync: () => undefined
      })
      const deltas = fromStart.snapshot.events.filter((event) => event.type === 'message.delta')
      expect(deltas.map((event) => (event.data as { text: string }).text)).toEqual(['one', 'two'])
      await fromStart.close()
      const later = await client.openRunStream({
        workspaceId: 'local-personal',
        runId: 'replayed',
        afterSeq: deltas[0].seq,
        onEvent: () => undefined,
        onResync: () => undefined
      })
      expect(later.snapshot.events.every((event) => event.seq > deltas[0].seq)).toBe(true)
      await later.close()
    } finally {
      client.close()
      await server.close()
      await scheduler.stop()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stops pushing after unsubscribe while the socket still serves other runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ola-push-unsubscribe-'))
    const endpoint = endpointFor(dir, 'push-unsubscribe')
    const journal = new RunJournal(join(dir, 'db'))
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const scheduler = new RunScheduler(
      journal,
      async (run, context) => {
        await context.emit('message.delta', { text: 'first' })
        if (run.runId === 'long') await gate
      },
      async () => undefined
    )
    const server = new RuntimeServer(scheduler, TOKEN, {
      workspaceIds: async () => new Set(['local-personal'])
    })
    const client = new RuntimeClient()
    const delivered: RunEvent[] = []
    try {
      await scheduler.initialize()
      await server.listen(endpoint)
      await client.connect(endpoint, TOKEN)
      await client.request('run.submit', spec('long'))
      const stream = await client.openRunStream({
        workspaceId: 'local-personal',
        runId: 'long',
        afterSeq: 0,
        onEvent: (event) => delivered.push(event),
        onResync: () => undefined
      })
      await stream.close()
      const deliveredAtClose = delivered.length
      release()
      await expect
        .poll(async () => {
          const snapshot = await client.request<RunSnapshot>('run.snapshot', {
            workspaceId: 'local-personal',
            runId: 'long'
          })
          return snapshot.run.status
        })
        .toBe('completed')
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(delivered).toHaveLength(deliveredAtClose)
      // The same socket still serves requests and new subscriptions.
      await client.request('run.submit', spec('short'))
      const other = await client.openRunStream({
        workspaceId: 'local-personal',
        runId: 'short',
        afterSeq: 0,
        onEvent: () => undefined,
        onResync: () => undefined
      })
      expect(other.snapshot.run.runId).toBe('short')
      await other.close()
    } finally {
      client.close()
      await server.close()
      await scheduler.stop()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
