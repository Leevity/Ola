import type { ModelDelta } from '../../src/runtime/core/agent'
import { describe, expect, it } from 'vitest'
import { OpenAIChatAdapter } from '../../src/runtime/providers/openai-chat'
import type { RunSpec } from '../../src/shared/runtime/contracts'
const run: RunSpec = {
  runId: 'r',
  requestId: 'q',
  taskId: 't',
  traceId: 't',
  sessionId: 's',
  workspaceId: 'local-personal',
  environmentId: 'local',
  modelSource: { kind: 'local', providerId: 'p', modelId: 'm' },
  prompt: 'hi',
  unattended: true
}
function response(text: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of new TextEncoder().encode(text)) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      }
    })
  )
}
async function collect(adapter: OpenAIChatAdapter) {
  const result: ModelDelta[] = []
  for await (const event of adapter.stream({
    run,
    messages: [{ role: 'user', text: 'hi' }],
    tools: [],
    signal: new AbortController().signal
  }))
    result.push(event)
  return result
}
describe('OpenAI compatible host codec', () => {
  it('decodes arbitrarily split UTF8, tool arguments and usage', async () => {
    const frames = [
      { choices: [{ delta: { content: '你好' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'c', function: { name: 'read', arguments: '{"path":' } }]
            }
          }
        ]
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] },
            finish_reason: 'tool_calls'
          }
        ]
      },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }
    ]
    const text =
      frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') +
      'data: [DONE]\r\n\r\n'
    const adapter = new OpenAIChatAdapter(
      async () => ({ baseUrl: 'http://localhost/v1', model: 'm', apiKey: 'test-key' }),
      (async (_url, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key')
        expect(init?.redirect).toBe('error')
        return response(text)
      }) as typeof fetch
    )
    expect(await collect(adapter)).toEqual([
      { type: 'text', text: '你好' },
      { type: 'usage', inputTokens: 3, outputTokens: 2 },
      { type: 'tool', call: { id: 'c', name: 'read', input: { path: 'a' } } }
    ])
  })
  it('never returns provider error bodies or silently accepts truncated output', async () => {
    const target = async () => ({ baseUrl: 'http://localhost/v1', model: 'm' })
    await expect(
      collect(
        new OpenAIChatAdapter(
          target,
          (async () => new Response('secret echoed here', { status: 401 })) as typeof fetch
        )
      )
    ).rejects.toThrow('PROVIDER_AUTH_REQUIRED')
    await expect(
      collect(
        new OpenAIChatAdapter(target, (async () =>
          response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')) as typeof fetch)
      )
    ).rejects.toThrow('MODEL_STREAM_TRUNCATED')
  })
  it('rejects the legacy managed placeholder before network access', async () => {
    let fetched = false
    const adapter = new OpenAIChatAdapter(
      async () => ({ baseUrl: 'https://ola.invalid/v1', model: 'm' }),
      (async () => {
        fetched = true
        return response('data: [DONE]\n\n')
      }) as typeof fetch
    )
    await expect(collect(adapter)).rejects.toThrow('INVALID_PROVIDER_URL')
    expect(fetched).toBe(false)
  })
})
