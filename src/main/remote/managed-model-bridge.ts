import { randomUUID } from 'node:crypto'
import { openManagedModelRequest } from './account-client'
import { getSession } from '../db/sessions-dao'

const streams = new Map<
  string,
  {
    reader: ReadableStreamDefaultReader<Uint8Array>
    abort: AbortController
    timer: ReturnType<typeof setTimeout>
    reading: boolean
    bytes: number
  }
>()
const endpoints = new Set([
  'chat/completions',
  'responses',
  'images/generations',
  'images/edits',
  'audio/speech',
  'audio/transcriptions',
  'embeddings'
])

export async function managedModelReverseRequest(method: string, input: unknown): Promise<unknown> {
  const params = input as Record<string, unknown> | null
  if (!params || typeof params !== 'object') throw new Error('Invalid Ola model request')
  if (method === 'ola/model-open') {
    if (streams.size >= 32) throw new Error('Too many active Ola model requests')
    const url = new URL(String(params.url))
    const match = /^\/workspaces\/([^/]+)\/resources\/([^/]+)\/v1\/(.+)$/.exec(url.pathname)
    if (
      url.origin !== 'https://ola.invalid' ||
      url.search ||
      url.hash ||
      !match ||
      !endpoints.has(match[3])
    ) {
      throw new Error('Unsupported Ola model endpoint')
    }
    if (typeof params.body !== 'string' || params.body.length > 32_000_000)
      throw new Error('Invalid Ola model body')
    const workspaceId = decodeURIComponent(match[1])
    const resourceId = decodeURIComponent(match[2])
    const sessionId =
      typeof params.sessionId === 'string' && params.sessionId
        ? params.sessionId
        : `aux-${randomUUID()}`
    const session = await getSession(sessionId)
    if (session && session.workspace_id !== workspaceId)
      throw new Error('Ola model workspace does not match the session')
    const abort = new AbortController()
    try {
      const response = await openManagedModelRequest({
        workspaceId,
        resourceId,
        sessionId,
        endpoint: match[3],
        body: Buffer.from(params.body, 'base64'),
        contentType:
          typeof params.contentType === 'string' ? params.contentType : 'application/json',
        signal: abort.signal
      })
      if (!response.body) throw new Error('Ola model returned an empty response')
      const handle = randomUUID()
      const timer = setTimeout(() => {
        void closeStream(handle)
      }, 10 * 60_000)
      timer.unref()
      streams.set(handle, {
        reader: response.body.getReader(),
        abort,
        timer,
        reading: false,
        bytes: 0
      })
      return {
        handle,
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream'
      }
    } catch (error) {
      abort.abort()
      throw error
    }
  }
  const handle = String(params.handle ?? '')
  const stream = streams.get(handle)
  if (method === 'ola/model-close') {
    await closeStream(handle)
    return { closed: true }
  }
  if (method !== 'ola/model-read' || !stream || stream.reading)
    throw new Error('Ola model stream unavailable')
  stream.reading = true
  try {
    const { value, done } = await stream.reader.read()
    stream.bytes += value?.byteLength ?? 0
    if (stream.bytes > 64_000_000) throw new Error('Ola model response exceeds the size limit')
    if (done) await closeStream(handle)
    return { done, data: value ? Buffer.from(value).toString('base64') : '' }
  } catch {
    await closeStream(handle)
    throw new Error('Ola model stream interrupted. Refresh your workspace or select a local model.')
  } finally {
    stream.reading = false
  }
}

async function closeStream(handle: string): Promise<void> {
  const stream = streams.get(handle)
  if (!stream) return
  streams.delete(handle)
  clearTimeout(stream.timer)
  stream.abort.abort()
  await stream.reader.cancel().catch(() => undefined)
}
