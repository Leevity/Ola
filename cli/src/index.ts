import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type Socket } from 'node:net'
import { decode, encode } from '@msgpack/msgpack'

type Frame = Record<string, unknown>
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

const HEADER_BYTES = 4
const args = process.argv.slice(2)
const command = args[0] ?? 'help'

function option(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function printHelp(): void {
  console.log(`Ola headless runtime

Usage:
  ola jobs [--limit N]
  ola job <jobId>
  ola cancel <jobId>
  ola run --params <json-file> [--worker <path>]

The params file is the same JSON payload accepted by the Ola agent/run route.`)
}

function createEndpoint(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\ola-cli-${process.pid}`
  return join(tmpdir(), `ola-cli-${process.pid}.sock`)
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(encode(value))
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32BE(payload.byteLength, 0)
  return Buffer.concat([header, payload])
}

class WorkerClient {
  private socket: Socket | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly events = new Set<(frame: Frame) => void>()

  async connect(workerPath?: string): Promise<void> {
    const endpoint = createEndpoint()
    const resolvedWorker = workerPath ?? process.env.OLA_NATIVE_WORKER_PATH
    if (!resolvedWorker || !existsSync(resolvedWorker)) {
      throw new Error('Set OLA_NATIVE_WORKER_PATH or pass --worker <path>.')
    }
    this.child = spawn(resolvedWorker, ['--ipc', endpoint], {
      stdio: 'pipe',
      env: { ...process.env, OLA_NATIVE_DEBUG: process.env.OLA_NATIVE_DEBUG ?? '0' }
    })
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    this.child.on('exit', (code) => {
      const error = new Error(`Ola Native Worker exited with code ${code ?? 'unknown'}`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now()
      const attempt = (): void => {
        const socket = connect(endpoint)
        socket.once('connect', () => {
          this.socket = socket
          socket.on('data', (chunk) => this.read(chunk))
          socket.on('error', (error) => this.failPending(error))
          resolve()
        })
        socket.once('error', () => {
          socket.destroy()
          if (Date.now() - startedAt > 10_000) reject(new Error('Timed out connecting to Ola Native Worker.'))
          else setTimeout(attempt, 40)
        })
      }
      attempt()
    })
  }

  onEvent(listener: (frame: Frame) => void): void {
    this.events.add(listener)
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const socket = this.socket
    if (!socket) throw new Error('Worker is not connected.')
    const id = this.nextId++
    const result = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    socket.write(frame({ id, method, params }))
    return await result
  }

  async close(): Promise<void> {
    this.socket?.destroy()
    this.child?.kill()
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.byteLength >= HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(0)
      if (this.buffer.byteLength < HEADER_BYTES + length) return
      const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length)
      this.buffer = this.buffer.subarray(HEADER_BYTES + length)
      const value = decode(payload) as Frame
      if (typeof value.id === 'number' && this.pending.has(value.id)) {
        const pending = this.pending.get(value.id)!
        this.pending.delete(value.id)
        if (typeof value.error === 'string') pending.reject(new Error(value.error))
        else pending.resolve(value.result)
      } else if (typeof value.event === 'string') {
        for (const listener of this.events) listener(value)
      }
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

async function main(): Promise<void> {
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  const client = new WorkerClient()
  await client.connect(option('--worker'))
  try {
    await client.request('db/initialize', {})
    if (command === 'jobs') {
      printJson(await client.request('runtime/jobs-list', { limit: Number(option('--limit') ?? 100) }))
      return
    }
    if (command === 'job') {
      const jobId = args[1]
      if (!jobId) throw new Error('Usage: ola job <jobId>')
      printJson(await client.request('runtime/jobs-get', { jobId }))
      return
    }
    if (command === 'cancel') {
      const jobId = args[1]
      if (!jobId) throw new Error('Usage: ola cancel <jobId>')
      printJson(await client.request('runtime/jobs-cancel', { jobId }))
      return
    }
    if (command === 'run') {
      const paramsPath = option('--params')
      if (!paramsPath) throw new Error('Usage: ola run --params <json-file>')
      const params = JSON.parse(readFileSync(paramsPath, 'utf8')) as Record<string, unknown>
      const run = await client.request<{ runId?: string }>('agent/run', params)
      printJson(run)
      client.onEvent((event) => {
        if (event.event !== 'agent/stream') return
        const payload = event.params as { events?: Array<Record<string, unknown>> } | undefined
        for (const item of payload?.events ?? []) {
          if (typeof item.text === 'string') process.stdout.write(item.text)
          if (typeof item.thinking === 'string') process.stderr.write(item.thinking)
          if (item.type === 'loop_end') process.stdout.write('\n')
        }
      })
      await new Promise<void>((resolve) => {
        const timer = setInterval(async () => {
          if (!run.runId) return
          const status = await client.request<{ active?: boolean }>('agent/run-status', { runId: run.runId })
          if (!status.active) {
            clearInterval(timer)
            resolve()
          }
        }, 250)
      })
      return
    }
    printHelp()
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
