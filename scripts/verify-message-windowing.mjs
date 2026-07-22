/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { decode, encode } from '@msgpack/msgpack'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const workerProject = path.join(
  repoRoot,
  'sidecars',
  'Ola.Native.Worker',
  'Ola.Native.Worker.csproj'
)
const frameHeaderBytes = 4
const maxFrameBytes = 256 * 1024 * 1024

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function messageContent(text) {
  return JSON.stringify(text)
}

function createFrame(payload) {
  if (payload.byteLength <= 0 || payload.byteLength > maxFrameBytes) {
    throw new Error(`Invalid frame payload length: ${payload.byteLength}`)
  }
  const frame = Buffer.allocUnsafe(frameHeaderBytes + payload.byteLength)
  frame.writeUInt32BE(payload.byteLength, 0)
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, frameHeaderBytes)
  return frame
}

export class NativeWorkerClient {
  constructor(endpoint, child) {
    this.endpoint = endpoint
    this.child = child
    this.socket = null
    this.readBuffer = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
    this.eventListeners = new Map()
  }

  async connect() {
    const deadline = Date.now() + 60_000
    let lastError = null
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(`Native worker exited before connect: ${this.child.exitCode}`)
      }
      try {
        this.socket = await new Promise((resolve, reject) => {
          const socket = net.createConnection(this.endpoint)
          socket.once('connect', () => resolve(socket))
          socket.once('error', reject)
        })
        this.socket.on('data', (chunk) => this.handleData(chunk))
        this.socket.on('error', (error) => this.rejectAll(error))
        this.socket.on('close', () => this.rejectAll(new Error('Native worker socket closed')))
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
    }
    throw lastError ?? new Error('Timed out connecting to native worker')
  }

  onEvent(eventName, listener) {
    const listeners = this.eventListeners.get(eventName) ?? new Set()
    listeners.add(listener)
    this.eventListeners.set(eventName, listeners)
    return () => listeners.delete(listener)
  }

  request(method, params = {}, timeoutMs = 20_000) {
    if (!this.socket) throw new Error('Native worker is not connected')
    const id = this.nextId++
    const payload = encode({ id, method, params })
    const frame = createFrame(payload)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Native worker request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this.socket.write(frame, (error) => {
        if (error) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  handleData(chunk) {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk])
    while (this.readBuffer.length >= frameHeaderBytes) {
      const length = this.readBuffer.readUInt32BE(0)
      if (length <= 0 || length > maxFrameBytes) {
        this.rejectAll(new Error(`Invalid frame length: ${length}`))
        return
      }
      const frameLength = frameHeaderBytes + length
      if (this.readBuffer.length < frameLength) return
      const payload = this.readBuffer.subarray(frameHeaderBytes, frameLength)
      this.readBuffer = this.readBuffer.subarray(frameLength)
      this.handleFrame(payload)
    }
  }

  handleFrame(payload) {
    const decoded = decode(payload)
    if (!decoded || typeof decoded !== 'object') return
    if (decoded.event) {
      this.emit(decoded.event, decoded)
      return
    }
    if (typeof decoded.id !== 'number') return
    const pending = this.pending.get(decoded.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(decoded.id)
    if (decoded.error) {
      pending.reject(new Error(String(decoded.error)))
    } else {
      pending.resolve(decoded.result)
    }
  }

  emit(eventName, payload) {
    const listeners = this.eventListeners.get(eventName)
    if (!listeners) return
    for (const listener of listeners) {
      listener(payload)
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  close() {
    this.socket?.destroy()
    this.rejectAll(new Error('Native worker closed'))
  }
}

export async function startWorker(tempDir, project = workerProject, extraEnv = {}) {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ola-verify-${process.pid}-${randomUUID()}`
      : path.join(tempDir, `ocw-${process.pid}.sock`)
  const child = spawn('dotnet', ['run', '--project', project, '--', '--ipc', endpoint], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OLA_NATIVE_DEBUG_BODY_PREVIEW_CHARS: '200000',
      ...extraEnv
    },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim()
    if (text) console.warn(`[native-worker] ${text}`)
  })
  const client = new NativeWorkerClient(endpoint, child)
  await client.connect()
  await client.request('worker/ping')
  return { client, child }
}

function buildSeedMessages(sessionId) {
  const messages = []
  const now = Date.now()
  for (let index = 0; index < 80; index += 1) {
    messages.push({
      id: `m${index}`,
      sessionId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: messageContent(`plain message ${index}`),
      meta: null,
      createdAt: now + index,
      usage:
        index === 79
          ? JSON.stringify({
              inputTokens: 1200,
              outputTokens: 12,
              contextTokens: 1200
            })
          : null,
      sortOrder: index
    })
  }
  return messages
}

function buildLongTranscript(sessionId, count = 5000) {
  const now = Date.now() + 50_000
  return Array.from({ length: count }, (_, index) => ({
    id: `long-${index}`,
    sessionId,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: messageContent(`${'x'.repeat(2000)} marker ${index}`),
    meta: null,
    createdAt: now + index,
    usage: null,
    sortOrder: index
  }))
}

function buildCompactArtifacts(sessionId, insertSortOrder) {
  const now = Date.now() + 10_000
  return [
    {
      id: 'compact-boundary',
      sessionId,
      role: 'system',
      content: messageContent('Conversation compacted'),
      meta: JSON.stringify({
        compactBoundary: {
          trigger: 'auto',
          preTokens: 1200,
          messagesSummarized: 60,
          preservedSegment: {
            headId: 'm60',
            anchorId: 'compact-summary',
            tailId: 'm61'
          }
        }
      }),
      createdAt: now,
      usage: null,
      sortOrder: insertSortOrder
    },
    {
      id: 'compact-summary',
      sessionId,
      role: 'user',
      content: messageContent(
        '[Context Memory Compressed Summary]\n\nSummary of messages 0 through 59. Keep this text.'
      ),
      meta: JSON.stringify({
        compactSummary: {
          messagesSummarized: 60,
          recentMessagesPreserved: true
        }
      }),
      createdAt: now + 1,
      usage: null,
      sortOrder: insertSortOrder + 1
    }
  ]
}

async function waitForRequestDebug(client, runId) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('Timed out waiting for request_debug event'))
    }, 20_000)
    const unsubscribe = client.onEvent('agent/stream', (frame) => {
      if (frame.runId !== runId) return
      for (const event of frame.events ?? []) {
        if (event.type === 'request_debug') {
          clearTimeout(timer)
          unsubscribe()
          resolve(event.debugInfo)
        }
      }
    })
  })
}

async function readRequestDebugBody(client, debugInfo) {
  if (typeof debugInfo.body === 'string') return debugInfo.body
  assert(typeof debugInfo.bodyRef === 'string', 'request_debug omitted body and bodyRef')
  const result = await client.request('agent/debug-body-read', { bodyRef: debugInfo.bodyRef })
  assert(result.success, `debug body read failed: ${result.error ?? 'unknown error'}`)
  assert(typeof result.body === 'string', 'debug body read omitted body')
  return result.body
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ola-windowing-'))
  const dbPath = path.join(tempDir, 'data.db')
  let client
  let child

  try {
    ;({ client, child } = await startWorker(tempDir))

    const memory = await client.request('worker/memory')
    assert(memory.success, `worker/memory failed: ${memory.error ?? 'unknown error'}`)
    assert(memory.pid > 0, `worker/memory returned invalid pid: ${memory.pid}`)
    assert(
      memory.workingSetBytes > 0,
      `worker/memory returned invalid working set: ${memory.workingSetBytes}`
    )

    const sessionId = 'session-windowing-smoke'
    const init = await client.request('db/initialize', { dbPath })
    assert(init.success, `db/initialize failed: ${init.error ?? 'unknown error'}`)
    await client.request('db/sessions-create', {
      dbPath,
      id: sessionId,
      title: 'Windowing smoke',
      mode: 'chat',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    await client.request('db/messages-add-batch', {
      dbPath,
      messages: buildSeedMessages(sessionId)
    })

    const markers = await client.request('db/messages-list-markers', { dbPath, sessionId })
    assert(markers.length === 80, `expected 80 message markers, got ${markers.length}`)
    assert(markers[0].role === 'user', 'message markers omitted user role')
    assert(markers[1].role === 'assistant', 'message markers omitted assistant role')

    const longSessionId = 'session-windowing-5000'
    await client.request('db/sessions-create', {
      dbPath,
      id: longSessionId,
      title: 'Long transcript',
      mode: 'chat',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    await client.request(
      'db/messages-add-batch',
      { dbPath, messages: buildLongTranscript(longSessionId) },
      120_000
    )
    const longMarkers = await client.request(
      'db/messages-list-markers',
      { dbPath, sessionId: longSessionId },
      120_000
    )
    assert(longMarkers.length === 5000, `expected 5000 message markers, got ${longMarkers.length}`)
    assert(
      longMarkers.every((row) => row.content.length <= 512),
      'message marker query loaded unbounded transcript content'
    )

    const around = await client.request('db/messages-window-around', {
      dbPath,
      sessionId,
      messageId: 'm50',
      limit: 11
    })
    assert(around.success, `window-around failed: ${around.error ?? 'unknown error'}`)
    assert(around.total === 80, `expected total=80 before artifacts, got ${around.total}`)
    assert(around.rows.length === 11, `expected 11 window rows, got ${around.rows.length}`)
    assert(around.anchorSortOrder === 50, `expected anchor sort 50, got ${around.anchorSortOrder}`)
    assert(around.rows[0].id === 'm45', `expected first window row m45, got ${around.rows[0]?.id}`)
    assert(
      around.rows.at(-1)?.id === 'm55',
      `expected last window row m55, got ${around.rows.at(-1)?.id}`
    )

    const requestContextRows = await client.request('db/messages-request-context', {
      dbPath,
      sessionId,
      maxMessages: 6
    })
    const requestContextIds = requestContextRows.map((row) => row.id)
    assert(
      requestContextIds.join(',') === 'm0,m75,m76,m77,m78,m79',
      `unexpected request context ids: ${requestContextIds.join(',')}`
    )

    const headTailDebugPromise = waitForRequestDebug(client, 'head-tail-run')
    await client.request('agent/run', {
      dbPath,
      runId: 'head-tail-run',
      sessionId,
      messages: [],
      contextSource: {
        sessionId,
        maxMessages: 6,
        compressionMode: 'auto'
      },
      provider: {
        type: 'openai-chat',
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'windowing-smoke-model'
      },
      tools: [],
      maxIterations: 1,
      forceApproval: false,
      includeFullDebugBody: true
    })
    const headTailDebugInfo = await headTailDebugPromise
    const headTailBody = JSON.stringify(
      JSON.parse(await readRequestDebugBody(client, headTailDebugInfo))
    )
    assert(headTailBody.includes('plain message 0'), 'request context omitted DB head task')
    assert(headTailBody.includes('plain message 79'), 'request context omitted DB tail')
    assert(!headTailBody.includes('plain message 10'), 'request context leaked middle history')
    await client.request('agent/cancel', { runId: 'head-tail-run' }).catch(() => {})

    const directDebugPromise = waitForRequestDebug(client, 'direct-bounded-run')
    await client.request('agent/run', {
      dbPath,
      runId: 'direct-bounded-run',
      sessionId,
      messages: [
        {
          id: 'direct-renderer-task',
          role: 'user',
          content: 'direct renderer bounded task context',
          createdAt: Date.now() + 30_000
        },
        {
          id: 'direct-renderer-tail',
          role: 'assistant',
          content: 'direct renderer tail context',
          createdAt: Date.now() + 30_001
        }
      ],
      contextSource: {
        sessionId,
        maxMessages: 6,
        compressionMode: 'auto'
      },
      provider: {
        type: 'openai-chat',
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'windowing-smoke-model'
      },
      tools: [],
      maxIterations: 1,
      forceApproval: false,
      includeFullDebugBody: true
    })
    const directDebugInfo = await directDebugPromise
    const directBody = JSON.stringify(
      JSON.parse(await readRequestDebugBody(client, directDebugInfo))
    )
    assert(directBody.includes('direct renderer bounded task context'), 'direct messages omitted')
    assert(!directBody.includes('plain message 79'), 'direct messages were replaced by DB context')
    await client.request('agent/cancel', { runId: 'direct-bounded-run' }).catch(() => {})

    const insert = await client.request('db/messages-insert-artifacts', {
      dbPath,
      sessionId,
      insertBeforeMessageId: 'm60',
      insertSortOrder: 60,
      messages: buildCompactArtifacts(sessionId, 60)
    })
    assert(insert.success, `insert artifacts failed: ${insert.error ?? 'unknown error'}`)
    assert(insert.inserted === 2, `expected inserted=2, got ${insert.inserted}`)
    assert(
      insert.start === 60 && insert.end === 62,
      `expected artifact range [60,62), got [${insert.start},${insert.end})`
    )
    assert(insert.total === 82, `expected total=82 after artifacts, got ${insert.total}`)

    const afterInsert = await client.request('db/messages-window-around', {
      dbPath,
      sessionId,
      sortOrder: 61,
      limit: 5
    })
    assert(
      afterInsert.success,
      `post-insert window failed: ${afterInsert.error ?? 'unknown error'}`
    )
    const postIds = afterInsert.rows.map((row) => row.id)
    assert(
      postIds.join(',') === 'm59,compact-boundary,compact-summary,m60,m61',
      `unexpected post-insert ids: ${postIds.join(',')}`
    )

    const compactRequestContextRows = await client.request('db/messages-request-context', {
      dbPath,
      sessionId,
      maxMessages: 6
    })
    const compactContextIds = compactRequestContextRows.map((row) => row.id)
    assert(compactContextIds.includes('m0'), 'compact request context omitted DB head')
    assert(compactContextIds.includes('compact-summary'), 'compact request context omitted summary')
    assert(compactContextIds.includes('m79'), 'compact request context omitted tail')
    assert(!compactContextIds.includes('m10'), 'compact request context leaked middle history')

    const count = await client.request('db/messages-count', { dbPath, sessionId })
    assert(
      count.success && count.count === 82,
      `expected persisted count 82, got ${JSON.stringify(count)}`
    )

    const debugPromise = waitForRequestDebug(client, 'windowing-run')
    await client.request('agent/run', {
      dbPath,
      runId: 'windowing-run',
      sessionId,
      messages: [],
      contextSource: {
        sessionId,
        maxMessages: 6,
        compressionMode: 'auto'
      },
      liveOverlayMessages: [
        {
          id: 'live-overlay-user',
          role: 'user',
          content: 'live overlay request from renderer',
          createdAt: Date.now() + 20_000
        }
      ],
      provider: {
        type: 'openai-chat',
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'windowing-smoke-model'
      },
      tools: [],
      maxIterations: 1,
      forceApproval: false,
      includeFullDebugBody: true
    })
    const debugInfo = await debugPromise
    const body = JSON.parse(await readRequestDebugBody(client, debugInfo))
    const serializedBody = JSON.stringify(body)
    assert(
      serializedBody.includes('Summary of messages 0 through 59'),
      'request context omitted compact summary'
    )
    assert(serializedBody.includes('plain message 79'), 'request context omitted DB tail')
    assert(
      serializedBody.includes('live overlay request from renderer'),
      'request context omitted live overlay'
    )
    assert(
      !serializedBody.includes('plain message 10'),
      'request context leaked old pre-summary history'
    )

    await client.request('agent/cancel', { runId: 'windowing-run' }).catch(() => {})
    console.log('message-windowing verification passed')
  } finally {
    client?.close()
    if (child && child.exitCode === null) {
      child.kill()
    }
    await rm(tempDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
