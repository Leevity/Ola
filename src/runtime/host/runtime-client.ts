import { randomUUID } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import {
  MAX_HOST_FRAME_BYTES,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeError,
  type RunEvent,
  type RunSnapshot,
  type RuntimeCapability
} from '../../shared/runtime/contracts'
import type { HostStreamFrame } from '../../shared/runtime/host-protocol'
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
      timer: ReturnType<typeof setTimeout> | null
    }
  >()
  private streams = new Map<
    string,
    RuntimeRunStreamOptions & { buffered: RunEvent[]; ready: boolean }
  >()
  private negotiated = new Set<RuntimeCapability>()
  private hostHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null
  /**
   * Register the host callback handler before connecting. Only a peer that
   * negotiated the `host` capability is ever asked, and an unregistered handler
   * answers with an error rather than silently dropping the request.
   */
  onRequest(handler: (method: string, params: unknown) => Promise<unknown>): void {
    this.hostHandler = handler
  }
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
            method?: unknown
            params?: unknown
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
          // A frame that carries a method is the server asking *us* to serve a
          // host callback, not an answer to one of our requests.
          if (typeof message.method === 'string') {
            this.serveHostRequest(socket, message.id, message.method, message.params)
            continue
          }
          const request = this.pending.get(message.id)
          if (!request) continue
          this.pending.delete(message.id)
          if (request.timer) clearTimeout(request.timer)
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
      if (this.negotiated.has('host')) decoder.allowHostFrames()
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
    const frame = encodeFrame({ id, method, params }, this.frameLimit())
    return new Promise((resolve, reject) => {
      // An approval or a nested run has no deadline; 0 leaves the wait to the
      // caller's own cancellation and to a lost connection.
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new RuntimeError('REQUEST_TIMEOUT'))
            }, timeout)
          : null
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.socket!.write(frame)
    })
  }

  private frameLimit(): number | undefined {
    return this.negotiated.has('host') ? MAX_HOST_FRAME_BYTES : undefined
  }

  /**
   * Feeds a model stream the runtime asked for. Deltas are notifications, not
   * answers, so a slow turn never occupies one of the request slots.
   */
  sendHostStream(frame: HostStreamFrame): void {
    const socket = this.socket
    if (!socket || socket.destroyed || !this.negotiated.has('host')) return
    socket.write(encodeFrame({ event: 'host.stream', ...frame }, MAX_HOST_FRAME_BYTES))
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

  /**
   * Host callbacks are answered concurrently, never queued behind each other:
   * the runtime can be waiting on a tool result while Main needs to submit a
   * nested run back through this same socket.
   */
  private serveHostRequest(
    socket: Socket,
    requestId: string,
    method: string,
    params: unknown
  ): void {
    const answer = (frame: Record<string, unknown>): void => {
      if (socket.destroyed) return
      try {
        socket.write(encodeFrame({ id: requestId, ...frame }, MAX_HOST_FRAME_BYTES))
      } catch {
        socket.destroy()
      }
    }
    const handler = this.hostHandler
    if (!handler) {
      answer({ error: 'HOST_CALLBACK_UNAVAILABLE' })
      return
    }
    void handler(method, params).then(
      (result) => answer({ result: result ?? null }),
      (error: unknown) => {
        const code =
          error &&
          typeof error === 'object' &&
          typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'HOST_CALLBACK_FAILED'
        answer({ error: code })
      }
    )
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
      if (request.timer) clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    // A dropped subscription must ask its consumer to reconcile. Clearing the
    // map silently would leave a run waiting for events that never arrive.
    if (this.streams.size > 0) {
      console.warn(
        `[TsRuntime] requesting resync for ${this.streams.size} run stream(s) (${error instanceof RuntimeError ? error.code : 'RESYNC_REQUIRED'})`
      )
    }
    for (const entry of this.streams.values()) {
      try {
        entry.onResync(error instanceof RuntimeError ? error.code : 'RESYNC_REQUIRED')
      } catch {
        /* A failed consumer cannot stop the rest from being told. */
      }
    }
    this.streams.clear()
  }
  close(): void {
    this.socket?.destroy()
    this.socket = null
    this.negotiated.clear()
    this.fail(new RuntimeError('RUNTIME_DISCONNECTED'))
  }
}
