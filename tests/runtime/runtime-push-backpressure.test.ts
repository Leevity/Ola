import { describe, expect, it } from 'vitest'
import { connect, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FrameDecoder, encodeFrame } from '../../src/runtime/host/framing'
import { RuntimeServer } from '../../src/runtime/host/runtime-server'
import { RunScheduler } from '../../src/runtime/scheduler/run-scheduler'
import { RunJournal } from '../../src/runtime/storage/run-journal'

const TOKEN = 's'.repeat(64)
/** Comfortably above the server's 512 KiB subscription buffer. */
const PAYLOAD = 'x'.repeat(128 * 1024)

type Frame = Record<string, unknown>

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

/** A raw socket so the test controls exactly when the server's writes drain. */
class SlowConsumer {
  readonly socket: Socket
  private decoder = new FrameDecoder()
  private frames: Frame[] = []
  private nextId = 0

  constructor(endpoint: string) {
    this.socket = connect(endpoint)
    this.socket.on('data', (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) this.frames.push(frame as Frame)
    })
  }

  async ready(): Promise<void> {
    if (!this.socket.connecting) return
    await new Promise<void>((resolve, reject) => {
      this.socket.once('connect', () => resolve())
      this.socket.once('error', reject)
    })
  }

  send(method: string, params: unknown): Promise<Frame> {
    const id = String(++this.nextId)
    this.socket.write(encodeFrame({ id, method, params }))
    return this.waitFor((frame) => frame.id === id)
  }

  waitFor(predicate: (frame: Frame) => boolean, timeout = 5000): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      const poll = (): void => {
        const index = this.frames.findIndex(predicate)
        if (index >= 0) {
          const [frame] = this.frames.splice(index, 1)
          clearInterval(timer)
          resolve(frame)
          return
        }
        // The server can drop a subscription before the caller starts reading,
        // so poll instead of relying on one socket callback.
      }
      const timer = setInterval(poll, 10)
      setTimeout(() => {
        clearInterval(timer)
        reject(new Error('FRAME_TIMEOUT'))
      }, timeout).unref?.()
    })
  }

  pause(): void {
    this.socket.pause()
  }

  resume(): void {
    this.socket.resume()
  }

  close(): void {
    this.socket.destroy()
  }
}

describe('run subscription backpressure', () => {
  it('resyncs a slow consumer instead of destroying the socket', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ola-push-backpressure-'))
    const endpoint = endpointFor(dir, 'push-backpressure')
    const journal = new RunJournal(join(dir, 'db'))
    let emit: ((type: string, data: unknown) => Promise<void>) | null = null
    const scheduler = new RunScheduler(
      journal,
      async (_run, context) => {
        emit = context.emit
        // Hold the run open so the consumer state, not the terminal status,
        // decides when the subscription ends.
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      async () => undefined
    )
    const server = new RuntimeServer(scheduler, TOKEN, {
      workspaceIds: async () => new Set(['local-personal'])
    })
    const consumer = { current: null as SlowConsumer | null }
    try {
      await scheduler.initialize()
      await server.listen(endpoint)
      const client = new SlowConsumer(endpoint)
      consumer.current = client
      await client.ready()
      await client.send('hello', {
        token: TOKEN,
        version: 1,
        capabilities: ['runs', 'replay', 'stream', 'cancel']
      })
      await client.send('run.submit', spec('slow'))
      await expect.poll(async () => (emit ? true : false), { timeout: 5000 }).toBe(true)
      await client.send('run.subscribe', {
        workspaceId: 'local-personal',
        runId: 'slow',
        afterSeq: 0
      })
      client.pause()
      for (let index = 0; index < 12; index += 1) {
        await emit!('message.delta', { text: PAYLOAD })
      }
      client.resume()
      const resync = await client.waitFor((frame) => frame.event === 'run.resync')
      expect(resync.reason).toBe('SLOW_CONSUMER')
      // The socket survives: a later request still completes on the same pipe.
      const ping = await client.send('ping', {})
      expect(ping.result).toEqual({ version: 1 })
      await client.send('run.cancel', { workspaceId: 'local-personal', runId: 'slow' })
    } finally {
      consumer.current?.close()
      await server.close()
      await scheduler.stop()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
