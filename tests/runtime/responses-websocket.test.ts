import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { ProtocolAdapter } from '../../src/runtime/providers/protocol-adapter'
import { LocalModelTransport, type ModelTarget } from '../../src/runtime/providers/transport'
import type { ModelDelta, ModelInput } from '../../src/shared/runtime/model'

const run = {
  runId: 'run',
  requestId: 'request',
  traceId: 'trace',
  taskId: 'task',
  workspaceId: 'local-personal',
  sessionId: 'session',
  environmentId: 'local' as const,
  prompt: 'hello',
  unattended: false,
  modelSource: { kind: 'local' as const, providerId: 'provider', modelId: 'model' }
}

const input = (): ModelInput => ({
  run,
  messages: [{ role: 'user', text: 'hello' }],
  tools: [],
  signal: new AbortController().signal
})

describe('Responses WebSocket transport', () => {
  let server: WebSocketServer | undefined

  afterEach(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  })

  it('adapts response.create and streamed events through the normal Responses codec', async () => {
    server = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => server!.once('listening', resolve))
    let connections = 0
    let responses = 0
    server.on('connection', (socket, request) => {
      connections++
      expect(request.headers.authorization).toBe('Bearer secret')
      socket.on('message', (raw) => {
        responses++
        const message = JSON.parse(raw.toString()) as {
          type: string
          response: Record<string, unknown>
        }
        expect(message.type).toBe('response.create')
        expect(message.response).toMatchObject({ model: 'model', input: expect.any(Array) })
        expect(message.response).not.toHaveProperty('stream')
        socket.send(
          JSON.stringify({
            type: 'response.output_text.delta',
            output_index: 0,
            delta: `hello-${responses}`
          })
        )
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: `response-${responses}`,
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: `hello-${responses}` }]
                }
              ],
              usage: { input_tokens: 2, output_tokens: 1 }
            }
          })
        )
        if (responses === 2) socket.close()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('WebSocket server did not start')
    const transport = new LocalModelTransport(async () => ({
      protocol: 'openai-responses' as const,
      model: 'model',
      baseUrl: 'https://example.test',
      apiKey: 'secret',
      websocketUrl: `ws://127.0.0.1:${address.port}`,
      websocketMode: 'auto' as const,
      responsesSessionScope: 'main'
    }))
    const adapter = new ProtocolAdapter(transport)
    const events: ModelDelta[] = []
    for await (const event of adapter.stream(input())) events.push(event)
    expect(events).toContainEqual({ type: 'text', text: 'hello-1' })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'usage', inputTokens: 2, outputTokens: 1 })
    )
    expect(events).toContainEqual({
      type: 'replay',
      replay: expect.objectContaining({ protocol: 'openai-responses', responseId: 'response-1' })
    })
    const second: ModelDelta[] = []
    for await (const event of adapter.stream(input())) second.push(event)
    expect(second).toContainEqual({ type: 'text', text: 'hello-2' })
    expect(connections).toBe(1)
  })

  it('falls back to HTTP when Responses WebSocket mode is disabled', async () => {
    let called = false
    const transport = new LocalModelTransport(
      async () => ({
        protocol: 'openai-responses' as const,
        model: 'model',
        baseUrl: 'https://example.test',
        websocketUrl: 'ws://127.0.0.1:1',
        websocketMode: 'disabled' as const
      }),
      async () => {
        called = true
        return new Response(
          'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{}}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    )
    const target: ModelTarget = await transport.resolve(run)
    await transport.request(
      run,
      target,
      { endpoint: 'responses', body: { model: 'model' } },
      input().signal
    )
    expect(called).toBe(true)
  })
})
