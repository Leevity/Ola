import { RuntimeError } from '../../shared/runtime/contracts'

export interface ServerEvent {
  event?: string
  data: string
}
export async function* readServerEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs = 60_000
): AsyncGenerator<ServerEvent> {
  const reader = body.getReader(),
    decoder = new TextDecoder()
  let buffer = ''
  let receivedBytes = 0
  const abort = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  const parse = (text: string): ServerEvent | null => {
    const lines = text.split('\n')
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim()
    return data ? { event, data } : null
  }
  try {
    while (true) {
      signal.throwIfAborted()
      let timer: ReturnType<typeof setTimeout> | undefined
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new RuntimeError('MODEL_STREAM_TIMEOUT')),
              idleTimeoutMs
            )
          })
        ])
      } finally {
        clearTimeout(timer)
      }
      signal.throwIfAborted()
      receivedBytes += chunk.value?.byteLength ?? 0
      if (receivedBytes > 16 * 1024 * 1024) throw new RuntimeError('MODEL_RESPONSE_TOO_LARGE')
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      // Bound a single unfinished event, not the size of an arbitrary TCP chunk.
      let index: number
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        if (index > 1024 * 1024) throw new RuntimeError('MODEL_FRAME_TOO_LARGE')
        const parsed = parse(buffer.slice(0, index))
        buffer = buffer.slice(index + 2)
        if (parsed) yield parsed
      }
      if (buffer.length > 1024 * 1024) throw new RuntimeError('MODEL_FRAME_TOO_LARGE')
      if (chunk.done) {
        const last = parse(buffer)
        if (last) yield last
        return
      }
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_MODEL_FRAME')
  return value as Record<string, unknown>
}
export function optionalObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}
export function parseEvent(data: string): Record<string, unknown> {
  try {
    return object(JSON.parse(data))
  } catch {
    throw new RuntimeError('INVALID_MODEL_FRAME')
  }
}
export function parseToolInput(value: string): unknown {
  if (value.length > 1024 * 1024) throw new RuntimeError('MODEL_FRAME_TOO_LARGE')
  try {
    return object(JSON.parse(value || '{}'))
  } catch {
    throw new RuntimeError('INVALID_TOOL_INPUT')
  }
}
