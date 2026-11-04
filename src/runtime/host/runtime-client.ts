import { randomUUID } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeError,
  type RunEvent,
  type RunSnapshot,
  type RuntimeCapability
} from '../../shared/runtime/contracts'
import { FrameDecoder, encodeFrame } from './framing'

export interface RuntimeRunStream {
  subscriptionId: string
  /** Replay up to `afterSeq`; pushed events continue after `snapshot.run.seq`. */
  snapshot: RunSnapshot
  /** Stops local delivery and asks the server to stop pushing. */
  close: () => Promise<void>
}

export interface RuntimeRunStreamOptions {
  workspaceId: string
  runId: string
  afterSeq: number
  onEvent: (event: RunEvent) => void
  /**
   * The server dropped the subscription (slow consumer, revoked workspace, or
   * a replay gap). The caller must reconcile with a snapshot; pushed events
   * after this point are no longer delivered.
   */
  onResync: (reason: string) => void
}

export class RuntimeClient {
  private socket: Socket | null = null
  private nextId = 0
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private streams = new Map<
    string,
    RuntimeRunStreamOptions & { buffered: RunEvent[]; ready: boolean }
  >()
  private negotiated = new Set<RuntimeCapability>()
  get capabilities(): ReadonlySet<RuntimeCapability> {
    return this.negotiated
  }
  async connect(
    endpoint: string,
    token: string,
    requestedCapabilities: readonly RuntimeCapability[] = RUNTIME_CAPABILITIES
  ): Promise<void> {
    if (this.socket) throw new RuntimeError('ALREADY_CONNECTED')
    const socket = connect(endpoint)
    this.socket = socket
    const decoder = new FrameDecoder()
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (!frame || typeof frame !== 'object') throw new RuntimeError('INVALID_RESPONSE')
          const message = frame as {
            id?: string
            error?: string
            result?: unknown
            event?: unknown
            subscriptionId?: unknown
            payload?: unknown
            reason?: unknown
          }
          // Server-initiated frames carry no request id and never resolve a
          // pending request.
          if (message.id === undefined) {
            this.dispatchNotification(message)
            continue
          }
          const request = this.pending.get(message.id)
          if (!request) continue
          this.pending.delete(message.id)
          clearTimeout(request.timer)
          if (message.error) request.reject(new RuntimeError(message.error))
          else request.resolve(message.result)
        }
      } catch {
        this.close()
      }
    })
    socket.on('error', () => this.fail(new RuntimeError('RUNTIME_DISCONNECTED')))
    socket.on('close', () => {
      this.socket = null
      this.fail(new RuntimeError('RUNTIME_DISCONNECTED'))
    })
    try {
      const hello = await this.request<unknown>(
        'hello',
        { token, version: RUNTIME_PROTOCOL_VERSION, capabilities: requestedCapabilities },
        5000
      )
      if (!hello || typeof hello !== 'object' || Array.isArray(hello))
        throw new RuntimeError('INVALID_RESPONSE')
      const response = hello as { version?: unknown; capabilities?: unknown }
      if (response.version !== RUNTIME_PROTOCOL_VERSION || !Array.isArray(response.capabilities))
        throw new RuntimeError('INVALID_RESPONSE')
      const capabilities = response.capabilities.map((capability) => {
        if (
          typeof capability !== 'string' ||
          !RUNTIME_CAPABILITIES.includes(capability as RuntimeCapability) ||
          !requestedCapabilities.includes(capability as RuntimeCapability)
        )
          throw new RuntimeError('INVALID_RESPONSE')
        return capability as RuntimeCapability
      })
      if (new Set(capabilities).size !== capabilities.length)
        throw new RuntimeError('INVALID_RESPONSE')
      this.negotiated = new Set(capabilities)
    } catch (error) {
      this.close()
      throw error
    }
  }
  request<T>(method: string, params: unknown = {}, timeout = 15000): Promise<T> {
    if (!this.socket || this.socket.destroyed)
      return Promise.reject(new RuntimeError('RUNTIME_DISCONNECTED'))
    if (this.pending.size >= 32) return Promise.reject(new RuntimeError('TOO_MANY_REQUESTS'))
    const id = String(++this.nextId)
    const frame = encodeFrame({ id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RuntimeError('REQUEST_TIMEOUT'))
      }, timeout)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.socket!.write(frame)
    })
  }

  /**
   * Subscribes before the snapshot read so no frame is missed. The server may
   * push events while the snapshot is still being produced; those are held
   * until the replay is applied and then delivered in `seq` order.
   *
   * A journal snapshot pages at 256 events, so a long run is replayed in pages
   * until the caller's cursor reaches the run's current sequence.
   */
  async openRunStream(options: RuntimeRunStreamOptions): Promise<RuntimeRunStream> {
    if (!this.negotiated.has('stream') || !this.negotiated.has('replay'))
      throw new RuntimeError('CAPABILITY_UNAVAILABLE')
    const subscriptionId = randomUUID()
    const entry = { ...options, buffered: [] as RunEvent[], ready: false }
    this.streams.set(subscriptionId, entry)
    try {
      const result = await this.request<{ subscriptionId: string; snapshot: RunSnapshot }>(
        'run.subscribe',
        {
          workspaceId: options.workspaceId,
          runId: options.runId,
          afterSeq: options.afterSeq,
          subscriptionId
        }
      )
      if (!result?.snapshot) throw new RuntimeError('INVALID_RESPONSE')
      let snapshot = result.snapshot
      // `run.seq` taken at subscribe time is the boundary: everything above it
      // is pushed into `buffered`, everything below is replayed from the journal.
      const subscribedSeq = snapshot.run.seq
      while ((snapshot.events.at(-1)?.seq ?? 0) < subscribedSeq) {
        const page = await this.request<RunSnapshot | null>('run.snapshot', {
          workspaceId: options.workspaceId,
          runId: options.runId,
          afterSeq: snapshot.events.at(-1)?.seq ?? 0
        })
        if (!page?.events.length) break
        snapshot = { ...page, events: [...snapshot.events, ...page.events] }
      }
      entry.ready = true
      for (const event of entry.buffered) {
        if (event.seq > subscribedSeq) options.onEvent(event)
      }
      entry.buffered = []
      return {
        subscriptionId,
        snapshot,
        close: async () => {
          this.streams.delete(subscriptionId)
          if (!this.socket || this.socket.destroyed) return
          await this.request('run.unsubscribe', {
            workspaceId: options.workspaceId,
            runId: options.runId,
            subscriptionId
          }).catch(() => undefined)
        }
      }
    } catch (error) {
      this.streams.delete(subscriptionId)
      throw error
    }
  }

  private dispatchNotification(message: {
    event?: unknown
    subscriptionId?: unknown
    payload?: unknown
    reason?: unknown
  }): void {
    if (typeof message.subscriptionId !== 'string') return
    const entry = this.streams.get(message.subscriptionId)
    if (!entry) return
    if (message.event === 'run.resync') {
      this.streams.delete(message.subscriptionId)
      entry.onResync(typeof message.reason === 'string' ? message.reason : 'RESYNC_REQUIRED')
      return
    }
    if (message.event !== 'run.event') return
    const payload = message.payload as RunEvent | undefined
    if (!payload || typeof payload !== 'object' || typeof payload.seq !== 'number') return
    if (!entry.ready) {
      entry.buffered.push(payload)
      return
    }
    entry.onEvent(payload)
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    this.streams.clear()
  }
  close(): void {
    this.socket?.destroy()
    this.socket = null
    this.negotiated.clear()
    this.fail(new RuntimeError('RUNTIME_DISCONNECTED'))
  }
}
