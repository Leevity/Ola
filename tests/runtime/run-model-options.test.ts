import { describe, expect, it } from 'vitest'
import { parseRunSpec } from '../../src/shared/runtime/contracts'
import { LocalModelTransport } from '../../src/runtime/providers/transport'

const spec = {
  runId: 'run',
  taskId: 'task',
  requestId: 'request',
  traceId: 'trace',
  sessionId: 'session',
  workspaceId: 'local-personal',
  environmentId: 'local',
  modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
  prompt: 'hello',
  unattended: false
}

describe('public run model options', () => {
  it('accepts bounded public execution parameters', () => {
    expect(
      parseRunSpec({
        ...spec,
        modelOptions: {
          systemPrompt: 'Be concise',
          maxTokens: 4096,
          temperature: 0,
          topP: 0.8,
          reasoningEffort: 'high',
          thinking: { type: 'enabled', budgetTokens: 2048 },
          enablePromptCache: true,
          cacheTtl: '1h',
          serviceTier: 'priority',
          promptCacheKey: 'workspace:local',
          responsesSessionScope: 'main',
          bodyOverrides: { response_format: { type: 'json_object' } },
          omitBodyKeys: ['top_p']
        }
      }).modelOptions
    ).toEqual({
      systemPrompt: 'Be concise',
      maxTokens: 4096,
      temperature: 0,
      topP: 0.8,
      reasoningEffort: 'high',
      thinking: { type: 'enabled', budgetTokens: 2048 },
      enablePromptCache: true,
      cacheTtl: '1h',
      serviceTier: 'priority',
      promptCacheKey: 'workspace:local',
      responsesSessionScope: 'main',
      bodyOverrides: { response_format: { type: 'json_object' } },
      omitBodyKeys: ['top_p']
    })
  })

  it.each([
    [{ apiKey: 'secret' }],
    [{ headers: { authorization: 'Bearer secret' } }],
    [{ bodyOverrides: { api_key: 'secret' } }],
    [{ bodyOverrides: { nested: { token: 'secret' } } }],
    [{ temperature: -0.1 }],
    [{ thinking: { type: 'enabled', budgetTokens: 1 } }]
  ])('rejects credentials and invalid execution parameters', (modelOptions) => {
    expect(() => parseRunSpec({ ...spec, modelOptions })).toThrow('INVALID_RUN')
  })

  it('rejects malformed public body override shapes', () => {
    expect(() => parseRunSpec({ ...spec, modelOptions: { bodyOverrides: [] } })).toThrow(
      'INVALID_RUN'
    )
    expect(() =>
      parseRunSpec({ ...spec, modelOptions: { omitBodyKeys: ['top_p', 'top_p'] } })
    ).toThrow('INVALID_RUN')
  })

  it('persists only a bounded public assistant message correlation', () => {
    expect(parseRunSpec({ ...spec, assistantMessageId: 'assistant-1' }).assistantMessageId).toBe(
      'assistant-1'
    )
    expect(() => parseRunSpec({ ...spec, assistantMessageId: '' })).toThrow('INVALID_RUN')
  })

  it('accepts bounded image content but rejects unsafe or oversized images', () => {
    expect(
      parseRunSpec({
        ...spec,
        prompt: '',
        promptImages: [
          { mimeType: 'image/png', data: 'aGVsbG8=' },
          { mimeType: 'image/webp', assetId: '00000000-0000-0000-0000-000000000000' }
        ],
        history: [
          {
            role: 'user',
            text: 'Earlier',
            images: [{ mimeType: 'image/jpeg', url: 'https://example.test/image.jpg' }]
          }
        ]
      })
    ).toMatchObject({
      prompt: '',
      promptImages: [
        { mimeType: 'image/png', data: 'aGVsbG8=' },
        { mimeType: 'image/webp', assetId: '00000000-0000-0000-0000-000000000000' }
      ],
      history: [{ images: [{ mimeType: 'image/jpeg' }] }]
    })
    expect(() =>
      parseRunSpec({
        ...spec,
        promptImages: [{ mimeType: 'image/png', url: 'http://example.test/image.png' }]
      })
    ).toThrow('INVALID_RUN')
    expect(() =>
      parseRunSpec({
        ...spec,
        promptImages: [{ mimeType: 'image/png', data: 'x'.repeat(768 * 1024 + 1) }]
      })
    ).toThrow('INVALID_RUN')
    expect(() =>
      parseRunSpec({
        ...spec,
        promptImages: [
          {
            mimeType: 'image/png',
            data: 'aGVsbG8=',
            assetId: '00000000-0000-0000-0000-000000000000'
          }
        ]
      })
    ).toThrow('INVALID_RUN')
  })

  it('binds channel tool context to the run', () => {
    expect(
      parseRunSpec({
        ...spec,
        channelContext: { pluginId: 'plugin-a', chatId: 'chat-a', messageId: 'message-a' }
      }).channelContext
    ).toEqual({ pluginId: 'plugin-a', chatId: 'chat-a', messageId: 'message-a' })
    expect(() => parseRunSpec({ ...spec, channelContext: { pluginId: 'plugin-a' } })).toThrow(
      'INVALID_RUN'
    )
  })

  it('allows an explicit local working directory and rejects it for other environments', () => {
    expect(parseRunSpec({ ...spec, workingDirectory: '/workspace' }).workingDirectory).toBe(
      '/workspace'
    )
    expect(() =>
      parseRunSpec({ ...spec, environmentId: 'ssh', workingDirectory: '/workspace' })
    ).toThrow('INVALID_RUN')
  })

  it('keeps extension activation explicit, bounded, normalized, and duplicate-free', () => {
    expect(
      parseRunSpec({ ...spec, extensionIds: [' Weather ', 'calendar_1'] }).extensionIds
    ).toEqual(['weather', 'calendar_1'])
    expect(() => parseRunSpec({ ...spec, extensionIds: ['weather', 'weather'] })).toThrow(
      'INVALID_RUN'
    )
    expect(() => parseRunSpec({ ...spec, extensionIds: ['../escape'] })).toThrow('INVALID_RUN')
  })

  it('keeps model-visible tools explicit and rejects malformed capability names', () => {
    expect(
      parseRunSpec({ ...spec, toolNames: ['web_search', 'mcp__docs__lookup'] }).toolNames
    ).toEqual(['web_search', 'mcp__docs__lookup'])
    expect(() => parseRunSpec({ ...spec, toolNames: ['web_search', 'web_search'] })).toThrow(
      'INVALID_RUN'
    )
    expect(() => parseRunSpec({ ...spec, toolNames: ['../shell'] })).toThrow('INVALID_RUN')
  })

  it('keeps loop and tool budgets explicit and bounded', () => {
    expect(parseRunSpec({ ...spec, maxTurns: 15, maxToolCalls: 40 })).toMatchObject({
      maxTurns: 15,
      maxToolCalls: 40
    })
    expect(() => parseRunSpec({ ...spec, maxTurns: 0 })).toThrow('INVALID_RUN')
    expect(() => parseRunSpec({ ...spec, maxToolCalls: 1.5 })).toThrow('INVALID_RUN')
  })

  it('overrides public target options without exposing credentials', async () => {
    const run = parseRunSpec({ ...spec, modelOptions: { temperature: 0, maxTokens: 512 } })
    const transport = new LocalModelTransport(async () => ({
      protocol: 'openai-chat',
      model: 'model',
      baseUrl: 'https://example.test',
      apiKey: 'secret',
      options: { temperature: 1, systemPrompt: 'Target default' }
    }))
    await expect(transport.resolve(run)).resolves.toEqual({
      protocol: 'openai-chat',
      model: 'model',
      options: { temperature: 0, maxTokens: 512, systemPrompt: 'Target default' }
    })
  })
})
