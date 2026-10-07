import { describe, expect, it } from 'vitest'
import type {
  ModelDelta,
  ModelInput,
  ModelProtocol,
  ProviderReplay
} from '../../src/shared/runtime/model'
import { ProtocolAdapter } from '../../src/runtime/providers/protocol-adapter'
import {
  AccountGatewayTransport,
  LocalModelTransport,
  type ModelTarget
} from '../../src/runtime/providers/transport'
import { anthropicCodec } from '../../src/runtime/providers/anthropic-codec'
import { responsesCodec } from '../../src/runtime/providers/responses-codec'
import { geminiCodec } from '../../src/runtime/providers/gemini-codec'
import { chatCodec } from '../../src/runtime/providers/chat-codec'
import { readServerEvents } from '../../src/runtime/providers/stream'

const input = (): ModelInput => ({
  run: {
    runId: 'r',
    requestId: 'q',
    traceId: 't',
    taskId: 't',
    workspaceId: 'local-personal',
    sessionId: 's',
    environmentId: 'local',
    prompt: 'hello',
    unattended: true,
    modelSource: { kind: 'local', providerId: 'p', modelId: 'm' }
  },
  messages: [{ role: 'user', text: 'hello' }],
  tools: [],
  signal: new AbortController().signal
})
function wire(frames: unknown[]): Response {
  const data = frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('')
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of new TextEncoder().encode(data)) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      }
    })
  )
}
async function collect(events: AsyncIterable<ModelDelta>): Promise<ModelDelta[]> {
  const result: ModelDelta[] = []
  for await (const event of events) result.push(event)
  return result
}
function replay(events: ModelDelta[]): ProviderReplay {
  const event = events.find((event) => event.type === 'replay')
  if (!event || event.type !== 'replay') throw new Error('Missing replay')
  return event.replay
}
const anthropicFrames = [
  { type: 'message_start', message: { usage: { input_tokens: 9, cache_read_input_tokens: 4 } } },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '', signature: '' }
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '检查' } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'signed-' }
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'value' } },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'call', name: 'read', input: {} }
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"path":' }
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '"a"}' }
  },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' }
]

describe('protocol replay and terminal integrity', () => {
  it('forwards Browser screenshot tool images as multimodal model context', () => {
    const target: ModelTarget = { protocol: 'anthropic', model: 'm' }
    const screenshotInput: ModelInput = {
      ...input(),
      messages: [
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'shot', name: 'BrowserScreenshot', input: {} }]
        },
        {
          role: 'tool',
          results: [
            {
              id: 'shot',
              name: 'BrowserScreenshot',
              output: '640x480 screenshot',
              images: [{ mimeType: 'image/png', data: 'cG5n' }]
            }
          ]
        }
      ]
    }
    const anthropic = anthropicCodec.encode(screenshotInput, target)
    const anthropicMessages = anthropic.body.messages as Array<{
      content: Array<Record<string, unknown>>
    }>
    expect(anthropicMessages[1].content[0]).toMatchObject({
      type: 'tool_result',
      content: [{ type: 'text', text: '640x480 screenshot' }, { type: 'image' }]
    })
    const chat = chatCodec.encode(screenshotInput, target)
    const chatMessages = chat.body.messages as Array<{ role: string; content: unknown }>
    const imageMessage = chatMessages.find((message) => message.role === 'user')
    expect(imageMessage?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image_url' })])
    )
    const responses = responsesCodec.encode(screenshotInput, target)
    expect(JSON.stringify(responses.body)).toContain('input_image')
    const gemini = geminiCodec.encode(screenshotInput, target)
    expect(JSON.stringify(gemini.body)).toContain('inlineData')
  })
  it('replays Anthropic signed thinking and tool results without exposing host credentials', async () => {
    const target: ModelTarget = { protocol: 'anthropic', model: 'm' }
    const events = await collect(anthropicCodec.decode(wire(anthropicFrames), input(), target))
    expect(events).toContainEqual({
      type: 'tool',
      call: { id: 'call', name: 'read', input: { path: 'a' } }
    })
    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 9,
      outputTokens: 3,
      cacheReadTokens: 4
    })
    const next = input()
    next.messages = [
      ...next.messages,
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'call', name: 'read', input: { path: 'a' } }],
        replay: replay(events)
      },
      { role: 'tool', results: [{ id: 'call', name: 'read', output: 'contents' }] }
    ]
    const encoded = anthropicCodec.encode(next, target)
    expect(JSON.stringify(encoded.body)).toContain('signed-value')
    expect(JSON.stringify(encoded.body)).toContain('tool_result')
    expect(replay(events).items[0]).not.toHaveProperty('cache_control')
    const missing = { ...next, messages: next.messages.slice(0, -1) }
    expect(() => anthropicCodec.encode(missing, target)).toThrow('MISSING_TOOL_RESULT')
  })
  it('never emits executable Anthropic calls before a successful terminal frame', async () => {
    const events: ModelDelta[] = []
    await expect(
      (async () => {
        for await (const event of anthropicCodec.decode(
          wire(anthropicFrames.slice(0, -1)),
          input(),
          { protocol: 'anthropic', model: 'm' }
        ))
          events.push(event)
      })()
    ).rejects.toThrow('MODEL_STREAM_TRUNCATED')
    expect(events.some((event) => event.type === 'tool')).toBe(false)
  })
  it('preserves Responses encrypted reasoning and avoids duplicate streamed text', async () => {
    const output = [
      { type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] },
      {
        type: 'message',
        id: 'msg',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello' }]
      },
      { type: 'function_call', id: 'fc', call_id: 'call', name: 'read', arguments: '{"path":"a"}' }
    ]
    const target: ModelTarget = { protocol: 'openai-responses', model: 'm' }
    const events = await collect(
      responsesCodec.decode(
        wire([
          { type: 'response.output_text.delta', output_index: 1, delta: 'Hello' },
          {
            type: 'response.output_item.added',
            output_index: 2,
            item: { ...output[2], arguments: '' }
          },
          {
            type: 'response.function_call_arguments.delta',
            output_index: 2,
            delta: '{"path":"a"}'
          },
          {
            type: 'response.completed',
            response: {
              id: 'resp',
              status: 'completed',
              output,
              usage: { input_tokens: 5, output_tokens: 2 }
            }
          }
        ]),
        input(),
        target
      )
    )
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: 'Hello' }
    ])
    const next = input()
    next.messages = [
      ...next.messages,
      { role: 'assistant', text: 'Hello', toolCalls: [], replay: replay(events) },
      { role: 'tool', results: [{ id: 'call', name: 'read', output: 'ok' }] }
    ]
    const encoded = responsesCodec.encode(next, target)
    expect(encoded.body.input).toEqual(expect.arrayContaining(output))
    expect(encoded.body).not.toHaveProperty('previous_response_id')
  })
  it.each(['gemini', 'vertex-ai'] as const)(
    'preserves %s function signatures and assigns distinct IDs across turns',
    async (protocol) => {
      const target: ModelTarget = { protocol, model: 'm' }
      const frames = [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: 'read', args: { path: 'a' } },
                    thoughtSignature: 'signature'
                  }
                ]
              },
              finishReason: 'STOP'
            }
          ],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 }
        }
      ]
      const events = await collect(geminiCodec.decode(wire(frames), input(), target))
      const call = events.find((event) => event.type === 'tool')
      expect(call).toMatchObject({ call: { signature: 'signature', input: { path: 'a' } } })
      const next = input()
      next.messages = [
        ...next.messages,
        { role: 'assistant', text: '', toolCalls: [], replay: replay(events) },
        { role: 'tool', results: [{ id: 'call', name: 'read', output: 'ok' }] }
      ]
      expect(JSON.stringify(geminiCodec.encode(next, target))).toContain('signature')
      const later = await collect(geminiCodec.decode(wire(frames), next, target))
      expect(later.find((event) => event.type === 'tool')).not.toEqual(call)
    }
  )
  it.each([
    [
      'anthropic',
      anthropicCodec,
      [{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }]
    ],
    ['openai-responses', responsesCodec, [{ type: 'response.incomplete' }]],
    ['gemini', geminiCodec, [{ candidates: [{ finishReason: 'MAX_TOKENS' }] }]]
  ] as const)('rejects incomplete %s generations', async (protocol, codec, frames) => {
    await expect(
      collect(codec.decode(wire([...frames]), input(), { protocol, model: 'm' }))
    ).rejects.toThrow('MODEL_OUTPUT_INCOMPLETE')
  })
})

describe('host transport', () => {
  it.each([
    ['anthropic', 'https://provider.test/v1', '/v1/messages'],
    ['gemini', 'https://provider.test/v1beta/openai', '/v1beta/models/m:streamGenerateContent'],
    [
      'vertex-ai',
      'https://provider.test/v1/projects/p/locations/l',
      '/v1/projects/p/locations/l/publishers/google/models/m:streamGenerateContent'
    ]
  ] as const)(
    'normalizes %s URLs and keeps secrets out of public target metadata',
    async (protocol, baseUrl, pathname) => {
      const transport = new LocalModelTransport(
        async () => ({ protocol, baseUrl, model: 'm', apiKey: 'secret-value' }),
        (async (url, init) => {
          expect(new URL(String(url)).pathname).toBe(pathname)
          expect(JSON.stringify(JSON.parse(String(init?.body)))).not.toContain('secret-value')
          expect(
            new Headers(init?.headers).get(
              protocol === 'anthropic' ? 'x-api-key' : 'x-goog-api-key'
            )
          ).toBe('secret-value')
          return wire(
            protocol === 'anthropic'
              ? [{ type: 'message_stop' }]
              : [{ candidates: [{ finishReason: 'STOP' }] }]
          )
        }) as typeof fetch
      )
      expect(await transport.resolve(input().run)).toEqual({ protocol, model: 'm' })
      await collect(new ProtocolAdapter(transport).stream(input()))
    }
  )
  it('rejects a model changed between resolution and request without fetching', async () => {
    let count = 0
    const transport = new LocalModelTransport(
      async () => ({
        protocol: 'openai-chat' as ModelProtocol,
        baseUrl: 'https://provider.test/v1',
        model: ++count === 1 ? 'a' : 'b'
      }),
      (async () => {
        throw new Error('Must not fetch')
      }) as typeof fetch
    )
    await expect(collect(new ProtocolAdapter(transport).stream(input()))).rejects.toThrow(
      'MODEL_BINDING_CHANGED'
    )
  })
  it('aborts an idle stream and times out stalled providers', async () => {
    const control = new AbortController()
    const reader = readServerEvents(new ReadableStream(), control.signal)
    const pending = reader.next()
    control.abort()
    await expect(pending).rejects.toThrow()
    await expect(
      readServerEvents(new ReadableStream(), new AbortController().signal, 5).next()
    ).rejects.toThrow('MODEL_STREAM_TIMEOUT')
  })
  it('does not dispatch a model request after cancellation during target resolution', async () => {
    const controller = new AbortController()
    let requests = 0
    const adapter = new ProtocolAdapter({
      resolve: async () => {
        controller.abort(new Error('workspace revoked'))
        return { protocol: 'openai-chat', model: 'm' }
      },
      request: async () => {
        requests++
        throw new Error('request must not start')
      }
    })
    await expect(
      collect(adapter.stream({ ...input(), signal: controller.signal }))
    ).rejects.toThrow('workspace revoked')
    expect(requests).toBe(0)
  })
  it('cancels a response body returned after the model request was revoked', async () => {
    const controller = new AbortController()
    let bodyCancelled = false
    const adapter = new ProtocolAdapter({
      resolve: async () => ({ protocol: 'openai-chat', model: 'm' }),
      request: async () => {
        controller.abort(new Error('workspace revoked'))
        return new Response(
          new ReadableStream({
            cancel() {
              bodyCancelled = true
            }
          })
        )
      }
    })
    await expect(
      collect(adapter.stream({ ...input(), signal: controller.signal }))
    ).rejects.toThrow('workspace revoked')
    expect(bodyCancelled).toBe(true)
  })

  it('sends managed model bodies only to the account gateway and never accepts a changed resource', async () => {
    const managedRun = input()
    managedRun.run = {
      ...managedRun.run,
      workspaceId: 'team-a',
      modelSource: { kind: 'ola-team', workspaceId: 'team-a', resourceId: 'resource-a' }
    }
    const calls: Array<Record<string, unknown>> = []
    const gatewayTransport = new AccountGatewayTransport(
      async () => ({
        workspaceId: 'team-a',
        resourceId: 'resource-a',
        protocol: 'openai-chat',
        model: 'managed-model'
      }),
      {
        async openManagedModelRequest(request) {
          calls.push({
            workspaceId: request.workspaceId,
            resourceId: request.resourceId,
            sessionId: request.sessionId,
            endpoint: request.endpoint,
            body: new TextDecoder().decode(request.body)
          })
          return new Response(
            'data: {"choices":[{"delta":{"content":"managed"}}]}\n\ndata: [DONE]\n\n'
          )
        }
      }
    )
    await expect(
      collect(new ProtocolAdapter(gatewayTransport).stream(managedRun))
    ).resolves.toContainEqual({
      type: 'text',
      text: 'managed'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      workspaceId: 'team-a',
      resourceId: 'resource-a',
      endpoint: 'chat/completions'
    })
    expect(String(calls[0].body)).not.toContain('ticket')

    const changed = new AccountGatewayTransport(
      async () => ({
        workspaceId: 'team-a',
        resourceId: 'other',
        protocol: 'openai-chat',
        model: 'managed-model'
      }),
      {
        openManagedModelRequest: async () => {
          throw new Error('must not run')
        }
      }
    )
    await expect(collect(new ProtocolAdapter(changed).stream(managedRun))).rejects.toThrow(
      'MODEL_UNAVAILABLE'
    )
  })
})

describe('headless protocol integration', () => {
  it.each(['anthropic', 'openai-responses', 'gemini', 'vertex-ai'] as const)(
    'completes a %s model/tool/model turn and keeps replay out of UI events',
    async (protocol) => {
      const { createAgentExecutor } = await import('../../src/runtime/core/agent')
      const { ToolExecutor } = await import('../../src/runtime/tools/tool-executor')
      let requests = 0,
        executions = 0
      const emitted: Array<{ type: string; data: unknown }> = []
      const adapter = new ProtocolAdapter(
        new LocalModelTransport(
          async () => ({ protocol, model: 'm', baseUrl: 'https://provider.test' }),
          (async (_url, options) => {
            const second = requests++ > 0
            if (second) expect(String(options?.body)).toContain('fixture-result')
            if (protocol === 'anthropic')
              return wire(
                second
                  ? [
                      {
                        type: 'content_block_start',
                        index: 0,
                        content_block: { type: 'text', text: 'done' }
                      },
                      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
                      { type: 'message_stop' }
                    ]
                  : anthropicFrames
              )
            if (protocol === 'openai-responses')
              return wire([
                {
                  type: 'response.completed',
                  response: {
                    status: 'completed',
                    output: second
                      ? [
                          {
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'output_text', text: 'done' }]
                          }
                        ]
                      : [
                          {
                            type: 'function_call',
                            call_id: 'call',
                            name: 'read',
                            arguments: '{"path":"a"}'
                          }
                        ]
                  }
                }
              ])
            return wire([
              {
                candidates: [
                  {
                    content: {
                      parts: second
                        ? [{ text: 'done' }]
                        : [
                            {
                              functionCall: { name: 'read', args: { path: 'a' } },
                              thoughtSignature: 'opaque-signature'
                            }
                          ]
                    },
                    finishReason: 'STOP'
                  }
                ]
              }
            ])
          }) as typeof fetch
        )
      )
      const executor = createAgentExecutor(
        adapter,
        new ToolExecutor(
          [
            {
              name: 'read',
              description: 'Read fixture',
              effect: 'read',
              inputSchema: { type: 'object' },
              validate: (value) => {
                expect(value).toEqual({ path: 'a' })
                return value
              },
              resources: async () => [],
              execute: async () => {
                executions++
                return 'fixture-result'
              }
            }
          ],
          async () => true
        )
      )
      await executor(input().run, {
        signal: input().signal,
        emit: async (type, data) => {
          emitted.push({ type, data })
        },
        requestInteraction: async () => {
          throw new Error('not used')
        }
      })
      expect(requests).toBe(2)
      expect(executions).toBe(1)
      expect(emitted.at(-1)).toMatchObject({
        type: 'message.completed',
        data: { text: 'done', toolCalls: [] }
      })
      expect(
        emitted
          .filter((event) => event.type === 'message.completed')
          .every((event) => !('replay' in (event.data as object)))
      ).toBe(true)
    }
  )
})
