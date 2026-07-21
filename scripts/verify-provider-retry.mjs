/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assert, startWorker } from './verify-message-windowing.mjs'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function waitForRun(client, runId, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const events = []
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out waiting for run ${runId}: ${JSON.stringify(events)}`))
    }, timeoutMs)
    const unsubscribe = client.onEvent('agent/stream', (frame) => {
      if (frame.runId !== runId) return
      events.push(...(frame.events ?? []))
      if (events.some((event) => event.type === 'loop_end')) {
        clearTimeout(timer)
        unsubscribe()
        resolve(events)
      }
    })
  })
}

async function runAgent(client, baseUrl, scenario, providerType, maxAttempts) {
  const runId = `${scenario}-${providerType}`
  const complete = waitForRun(client, runId)
  await client.request('agent/run', {
    runId,
    sessionId: `session-${runId}`,
    messages: [{ id: 'user-1', role: 'user', content: 'hello', createdAt: Date.now() }],
    provider: {
      type: providerType,
      apiKey: 'test-key',
      baseUrl: `${baseUrl}/${scenario}`,
      model: 'retry-verification-model'
    },
    tools: [],
    maxIterations: 1,
    providerRetryMaxAttempts: maxAttempts,
    forceApproval: false
  })
  return { runId, complete }
}

function retryEvents(events) {
  return events.filter((event) => event.type === 'request_retry')
}

async function main() {
  const counts = new Map()
  const server = createServer((request, response) => {
    const scenario = request.url?.split('/').filter(Boolean)[0] ?? 'unknown'
    const count = (counts.get(scenario) ?? 0) + 1
    counts.set(scenario, count)

    if (scenario === 'bad-request') {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end('{"error":"invalid request"}')
      return
    }
    if (scenario === 'retry-after') {
      response.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' })
      response.end('{"error":"rate limited"}')
      return
    }
    if (scenario === 'eventual' && count >= 3) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'
      )
      return
    }
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end('{"error":"temporary failure"}')
  })

  const address = await listen(server)
  const baseUrl = `http://127.0.0.1:${address.port}`
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ola-provider-retry-'))
  let client
  let child
  try {
    ;({ client, child } = await startWorker(tempDir))

    const badRequest = await runAgent(client, baseUrl, 'bad-request', 'openai-chat', 4)
    const badRequestEvents = await badRequest.complete
    assert(retryEvents(badRequestEvents).length === 0, 'HTTP 400 must not retry')
    assert(counts.get('bad-request') === 1, 'HTTP 400 issued more than one request')

    const exhausted = await runAgent(client, baseUrl, 'exhausted', 'openai-responses', 3)
    const exhaustedEvents = await exhausted.complete
    assert(retryEvents(exhaustedEvents).length === 2, 'HTTP 500 did not exhaust three attempts')
    assert(counts.get('exhausted') === 3, 'max attempt setting was not enforced')

    const eventual = await runAgent(client, baseUrl, 'eventual', 'gemini', 4)
    const eventualEvents = await eventual.complete
    assert(retryEvents(eventualEvents).length === 2, 'eventual success did not retry twice')
    assert(
      eventualEvents.some((event) => event.type === 'text_delta'),
      'eventual success missing output'
    )
    assert(counts.get('eventual') === 3, 'eventual success request count mismatch')

    const cancel = await runAgent(client, baseUrl, 'retry-after', 'anthropic', 4)
    const cancelStartedAt = Date.now()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Retry-After event was not emitted')), 5_000)
      const unsubscribe = client.onEvent('agent/stream', async (frame) => {
        if (frame.runId !== cancel.runId) return
        const retry = (frame.events ?? []).find((event) => event.type === 'request_retry')
        if (!retry) return
        clearTimeout(timer)
        unsubscribe()
        assert(retry.delayMs >= 1_000, 'Retry-After delay was not preserved')
        await client.request('agent/cancel', { runId: cancel.runId })
        resolve()
      })
    })
    const cancelEvents = await cancel.complete
    assert(Date.now() - cancelStartedAt < 3_000, 'cancellation did not interrupt retry wait')
    assert(counts.get('retry-after') === 1, 'request continued after cancellation')
    assert(
      cancelEvents.some((event) => event.type === 'loop_end' && event.reason === 'aborted'),
      'cancelled retry did not end as aborted'
    )

    console.log('provider-retry verification passed')
  } finally {
    client?.close()
    if (child && child.exitCode === null) child.kill()
    await new Promise((resolve) => server.close(resolve))
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
