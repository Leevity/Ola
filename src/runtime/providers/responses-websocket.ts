import WebSocket from 'ws'

const MAX_FRAME_BYTES = 4 * 1024 * 1024

function validateWebSocketUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('INVALID_PROVIDER_URL')
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('INVALID_PROVIDER_URL')
  if (url.hostname === 'ola.invalid') throw new Error('INVALID_PROVIDER_URL')
  return url
}

function responseFrame(data: string): string {
  try {
    return `data: ${JSON.stringify(JSON.parse(data))}\n\n`
  } catch {
    throw new Error('INVALID_MODEL_FRAME')
  }
}

/**
 * Adapt one Responses API WebSocket exchange to the codec's bounded SSE-like
 * stream. The socket is intentionally request-scoped: cancellation and
 * provider failures cannot leak a reusable authenticated connection across
 * workspace runs. Session reuse remains an explicit future capability.
 */
export async function openResponsesWebSocket(input: {
  url: string
  headers: Headers
  body: Record<string, unknown>
  signal: AbortSignal
}): Promise<Response> {
  const url = validateWebSocketUrl(input.url)
  let cancelSocket = (): void => undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let settled = false
      let streamClosed = false
      const socket = new WebSocket(url, { headers: Object.fromEntries(input.headers.entries()) })
      const close = (): void => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
          socket.close()
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        close()
        if (!streamClosed) {
          streamClosed = true
          controller.error(error instanceof Error ? error : new Error(String(error)))
        }
      }
      const abort = (): void => fail(new DOMException('The operation was aborted', 'AbortError'))
      cancelSocket = (): void => {
        streamClosed = true
        input.signal.removeEventListener('abort', abort)
        close()
      }
      input.signal.addEventListener('abort', abort, { once: true })
      socket.once('open', () => {
        if (input.signal.aborted) return abort()
        try {
          const { stream: _stream, ...response } = input.body
          socket.send(JSON.stringify({ type: 'response.create', response }))
        } catch (error) {
          fail(error)
        }
      })
      socket.on('message', (data: WebSocket.RawData) => {
        if (settled) return
        const frame = typeof data === 'string' ? data : data.toString()
        if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES)
          return fail(new Error('MODEL_FRAME_TOO_LARGE'))
        try {
          controller.enqueue(new TextEncoder().encode(responseFrame(frame)))
        } catch (error) {
          fail(error)
        }
      })
      socket.once('error', fail)
      socket.once('close', () => {
        input.signal.removeEventListener('abort', abort)
        if (!settled) {
          settled = true
          if (!streamClosed) {
            streamClosed = true
            try {
              controller.close()
            } catch {
              // The consumer may have cancelled the response concurrently.
            }
          }
        }
      })
    },
    cancel() {
      cancelSocket()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

type ActiveResponse = {
  controller: ReadableStreamDefaultController<Uint8Array>
  signal: AbortSignal
  abort: () => void
}

class ReusableResponsesSession {
  readonly socket: WebSocket
  readonly ready: Promise<void>
  private active: ActiveResponse | null = null
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    url: URL,
    headers: Headers,
    private readonly onClosed: () => void
  ) {
    this.socket = new WebSocket(url, { headers: Object.fromEntries(headers.entries()) })
    this.ready = new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve())
      this.socket.once('error', reject)
    })
    this.socket.on('message', (data: WebSocket.RawData) => this.handleMessage(data))
    this.socket.once('error', (error) => this.fail(error))
    this.socket.once('close', () => this.fail(new Error('RESPONSES_WEBSOCKET_CLOSED')))
  }

  async start(input: { body: Record<string, unknown>; signal: AbortSignal }): Promise<Response> {
    if (this.active) throw new Error('RESPONSES_WEBSOCKET_BUSY')
    if (input.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const abort = (): void => this.cancel(controller)
        this.active = { controller, signal: input.signal, abort }
        input.signal.addEventListener('abort', abort, { once: true })
        void this.send(input.body).catch((error) => this.fail(error))
      },
      cancel: () => {
        this.cancel()
      }
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )
      this.socket.close()
    this.fail(new Error('RESPONSES_WEBSOCKET_CLOSED'))
  }

  private async send(body: Record<string, unknown>): Promise<void> {
    await this.ready
    if (!this.active) return
    const { stream: _stream, ...response } = body
    this.socket.send(JSON.stringify({ type: 'response.create', response }))
  }

  private handleMessage(data: WebSocket.RawData): void {
    if (!this.active) return
    const frame = typeof data === 'string' ? data : data.toString()
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) {
      this.fail(new Error('MODEL_FRAME_TOO_LARGE'))
      return
    }
    try {
      const parsed = JSON.parse(frame) as { type?: unknown }
      this.active.controller.enqueue(new TextEncoder().encode(responseFrame(frame)))
      if (parsed.type === 'response.completed' || parsed.type === 'response.done') this.finish()
    } catch (error) {
      this.fail(error)
    }
  }

  private finish(): void {
    const active = this.active
    if (!active) return
    this.active = null
    active.signal.removeEventListener('abort', active.abort)
    try {
      active.controller.close()
    } catch {
      // The consumer may have cancelled after the terminal frame.
    }
    this.idleTimer = setTimeout(() => this.close(), 5 * 60 * 1000)
  }

  private cancel(controller?: ReadableStreamDefaultController<Uint8Array>): void {
    const active = this.active
    if (active && (!controller || active.controller === controller)) {
      this.active = null
      active.signal.removeEventListener('abort', active.abort)
    }
    this.close()
  }

  private fail(error: unknown): void {
    const active = this.active
    this.active = null
    if (active) {
      active.signal.removeEventListener('abort', active.abort)
      try {
        active.controller.error(error instanceof Error ? error : new Error(String(error)))
      } catch {
        // The consumer may have cancelled the response concurrently.
      }
    }
    this.onClosed()
  }
}

/** Workspace/session-scoped pool for providers that support reusable Responses sockets. */
export class ResponsesWebSocketPool {
  private readonly sessions = new Map<string, ReusableResponsesSession>()

  async open(input: {
    key: string
    url: string
    headers: Headers
    body: Record<string, unknown>
    signal: AbortSignal
  }): Promise<Response> {
    const url = validateWebSocketUrl(input.url)
    let session = this.sessions.get(input.key)
    if (!session) {
      session = new ReusableResponsesSession(url, input.headers, () => {
        if (this.sessions.get(input.key) === session) this.sessions.delete(input.key)
      })
      this.sessions.set(input.key, session)
    }
    return await session.start({ body: input.body, signal: input.signal })
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
}
