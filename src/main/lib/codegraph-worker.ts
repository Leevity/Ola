import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { decode, encode } from '@msgpack/msgpack'

const FRAME_HEADER_BYTES = 4
const MAX_FRAME_BYTES = 256 * 1024 * 1024
const WORKER_RESTART_INITIAL_DELAY_MS = 250
const WORKER_RESTART_MAX_DELAY_MS = 10_000
const CODEGRAPH_GRAMMAR_LIBRARIES = [
  'tree-sitter',
  'tree-sitter-typescript',
  'tree-sitter-tsx',
  'tree-sitter-javascript',
  'tree-sitter-python',
  'tree-sitter-go',
  'tree-sitter-java',
  'tree-sitter-c-sharp',
  'tree-sitter-rust',
  'tree-sitter-c',
  'tree-sitter-cpp',
  'tree-sitter-php',
  'tree-sitter-ruby',
  'tree-sitter-scala',
  'tree-sitter-bash',
  'tree-sitter-haskell',
  'tree-sitter-julia',
  'tree-sitter-razor'
] as const

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface WorkerFrame {
  id?: number
  result?: unknown
  error?: string
  event?: string
  params?: unknown
}

export type CodeGraphWorkerLifecycleEvent = {
  status: 'ready' | 'stopped' | 'restarting'
  generation: number
  error?: Error
  retryDelayMs?: number
}

function executableName(): string {
  return process.platform === 'win32' ? 'Ola.CodeGraph.Worker.exe' : 'Ola.CodeGraph.Worker'
}

export function resolveCodeGraphWorkerPath(): string | null {
  const executable = executableName()
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'native-worker', 'codegraph-worker', executable)]
    : [
        path.join(process.cwd(), 'resources', 'native-worker', 'codegraph-worker', executable),
        path.join(
          process.cwd(),
          'sidecars',
          'Ola.CodeGraph.Worker',
          'bin',
          'Debug',
          'net10.0',
          executable
        )
      ]
  return (
    candidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile() && fs.statSync(candidate).size > 0
      } catch {
        return false
      }
    }) ?? null
  )
}

export function resolveCodeGraphGrammarsDir(workerPath: string): string | null {
  const override = process.env.OLA_CODEGRAPH_GRAMMARS_DIR?.trim()
  const candidates = [override, path.join(path.dirname(workerPath), 'grammars')].filter(
    (candidate): candidate is string => Boolean(candidate)
  )
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

function codeGraphGrammarFileName(library: string): string {
  if (process.platform === 'win32') return `${library}.dll`
  if (process.platform === 'darwin') return `lib${library}.dylib`
  return `lib${library}.so`
}

export function getCodeGraphGrammarStatus(grammarsDir: string | null): {
  expected: number
  available: number
  missing: string[]
} {
  const missing = CODEGRAPH_GRAMMAR_LIBRARIES.map(codeGraphGrammarFileName).filter((file) => {
    if (!grammarsDir) return true
    try {
      return !fs.statSync(path.join(grammarsDir, file)).isFile()
    } catch {
      return true
    }
  })
  return {
    expected: CODEGRAPH_GRAMMAR_LIBRARIES.length,
    available: CODEGRAPH_GRAMMAR_LIBRARIES.length - missing.length,
    missing
  }
}

function endpointPath(): string {
  const id = `${process.pid}-${randomUUID().slice(0, 12)}`
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\ola-codegraph-${id}`
    : path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), `ola-cg-${id}.sock`)
}

function createFrame(payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength)
  frame.writeUInt32BE(payload.byteLength, 0)
  Buffer.from(payload).copy(frame, FRAME_HEADER_BYTES)
  return frame
}

export class CodeGraphWorkerManager {
  private child: ChildProcess | null = null
  private socket: net.Socket | null = null
  private endpoint: string | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private readBuffer = Buffer.alloc(0)
  private startPromise: Promise<void> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempts = 0
  private generationValue = 0
  private stopping = false
  private events = new EventEmitter()

  get isRunning(): boolean {
    return Boolean(
      this.child &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.socket &&
      !this.socket.destroyed
    )
  }

  get generation(): number {
    return this.generationValue
  }

  onEvent(eventName: string, listener: (params: unknown) => void): () => void {
    this.events.on(eventName, listener)
    return () => this.events.off(eventName, listener)
  }

  onLifecycle(listener: (event: CodeGraphWorkerLifecycleEvent) => void): () => void {
    this.events.on('worker/lifecycle', listener)
    return () => this.events.off('worker/lifecycle', listener)
  }

  async healthCheck(): Promise<void> {
    await this.request('worker/ping', {}, 10_000)
  }

  async ensureStarted(): Promise<void> {
    if (this.isRunning) return
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null
      })
    }
    await this.startPromise
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    await this.ensureStarted()
    if (!this.socket || !this.isRunning) throw new Error('CodeGraph worker is not running')
    const id = this.nextId++
    const payload = encode({ id, method, params: params ?? {} })
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`CodeGraph request timed out: ${method}`)
        reject(error)
        // A timed-out request means the IPC stream can no longer be trusted: its late response
        // may arrive after callers have moved on and a blocked worker would make every refresh
        // time out in turn. Recycle it so the next request starts from a clean transport.
        this.closeWorker(error)
      }, timeoutMs)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.socket?.write(createFrame(payload), (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  async recycle(): Promise<void> {
    await this.stop()
    await this.ensureStarted()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.closeWorker(new Error('CodeGraph worker stopped'))
    this.stopping = false
  }

  private async start(): Promise<void> {
    const workerPath = resolveCodeGraphWorkerPath()
    if (!workerPath) throw new Error('CodeGraph worker assets are missing')
    const endpoint = endpointPath()
    if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true })
    const grammarsDir = resolveCodeGraphGrammarsDir(workerPath)
    const child = spawn(workerPath, ['--ipc', endpoint], {
      cwd: path.dirname(workerPath),
      env: {
        ...process.env,
        ...(grammarsDir ? { OLA_CODEGRAPH_GRAMMARS_DIR: grammarsDir } : {})
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    this.child = child
    this.endpoint = endpoint
    child.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message) console.warn(`[CodeGraphWorker] ${message}`)
    })
    child.on('exit', () => {
      if (this.child === child) this.closeWorker(new Error('CodeGraph worker exited'))
    })
    child.on('error', (error) => {
      if (this.child === child) this.closeWorker(error)
    })
    const socket = await this.connect(endpoint, child)
    this.socket = socket
    socket.on('data', (chunk) => this.handleData(chunk))
    socket.on('error', (error) => {
      if (this.socket === socket) this.closeWorker(error)
    })
    socket.on('close', () => {
      if (this.socket === socket && !this.stopping) {
        this.closeWorker(new Error('CodeGraph worker IPC closed'))
      }
    })
    await this.request('worker/ping', {}, 10_000)
    this.generationValue += 1
    this.restartAttempts = 0
    this.events.emit('worker/lifecycle', {
      status: 'ready',
      generation: this.generationValue
    } satisfies CodeGraphWorkerLifecycleEvent)
    console.log('[CodeGraphWorker] IPC connected', { pid: child.pid ?? null, workerPath })
  }

  private async connect(endpoint: string, child: ChildProcess): Promise<net.Socket> {
    const deadline = Date.now() + 10_000
    let lastError: Error | null = null
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('CodeGraph worker exited before IPC connect')
      try {
        return await new Promise<net.Socket>((resolve, reject) => {
          const socket = net.createConnection(endpoint)
          socket.once('connect', () => resolve(socket))
          socket.once('error', reject)
        })
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    throw lastError ?? new Error('Timed out connecting to CodeGraph worker')
  }

  private handleData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk])
    while (this.readBuffer.length >= FRAME_HEADER_BYTES) {
      const length = this.readBuffer.readUInt32BE(0)
      if (length <= 0 || length > MAX_FRAME_BYTES) {
        this.closeWorker(new Error(`Invalid CodeGraph frame length: ${length}`))
        return
      }
      if (this.readBuffer.length < FRAME_HEADER_BYTES + length) return
      const payload = this.readBuffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length)
      this.readBuffer = this.readBuffer.subarray(FRAME_HEADER_BYTES + length)
      const frame = decode(payload) as WorkerFrame
      if (frame.event) {
        this.events.emit(frame.event, frame.params)
        continue
      }
      if (typeof frame.id !== 'number') continue
      const pending = this.pending.get(frame.id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(frame.id)
      if (frame.error) pending.reject(new Error(frame.error))
      else pending.resolve(frame.result)
    }
  }

  private closeWorker(error: Error): void {
    const child = this.child
    const socket = this.socket
    const endpoint = this.endpoint
    const hadWorker = child !== null || socket !== null

    this.child = null
    this.socket = null
    this.endpoint = null
    this.readBuffer = Buffer.alloc(0)
    socket?.removeAllListeners()
    socket?.destroy()
    if (child && !child.killed && child.exitCode === null) child.kill()
    if (endpoint && process.platform !== 'win32') fs.rmSync(endpoint, { force: true })

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()

    if (!hadWorker) return
    this.events.emit('worker/lifecycle', {
      status: 'stopped',
      generation: this.generationValue,
      error
    } satisfies CodeGraphWorkerLifecycleEvent)
    if (!this.stopping) this.scheduleRestart(error)
  }

  private scheduleRestart(error: Error): void {
    if (this.restartTimer || this.isRunning) return

    const retryDelayMs = Math.min(
      WORKER_RESTART_MAX_DELAY_MS,
      WORKER_RESTART_INITIAL_DELAY_MS * 2 ** this.restartAttempts
    )
    this.restartAttempts += 1
    this.events.emit('worker/lifecycle', {
      status: 'restarting',
      generation: this.generationValue,
      error,
      retryDelayMs
    } satisfies CodeGraphWorkerLifecycleEvent)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.ensureStarted().catch((restartError) => {
        const normalized =
          restartError instanceof Error ? restartError : new Error(String(restartError))
        console.warn('[CodeGraphWorker] restart failed', { error: normalized.message })
        this.scheduleRestart(normalized)
      })
    }, retryDelayMs)
  }
}

const codeGraphWorker = new CodeGraphWorkerManager()

export function getCodeGraphWorker(): CodeGraphWorkerManager {
  return codeGraphWorker
}
