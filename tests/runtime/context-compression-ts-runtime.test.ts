import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig, UnifiedMessage } from '../../src/renderer/src/lib/api/types'

const {
  isTsRuntimeAvailable,
  streamTsRuntimeTextTurn,
  resolveTsRuntimeModelBinding,
  assessTsRuntimeTextEligibility
} = vi.hoisted(() => ({
  isTsRuntimeAvailable: vi.fn(),
  streamTsRuntimeTextTurn: vi.fn(),
  resolveTsRuntimeModelBinding: vi.fn(),
  assessTsRuntimeTextEligibility: vi.fn()
}))

vi.mock('../../src/renderer/src/lib/ipc/ts-runtime-bridge', () => ({
  isTsRuntimeAvailable,
  streamTsRuntimeTextTurn
}))
vi.mock('../../src/renderer/src/lib/ipc/ts-runtime-model-binding', () => ({
  resolveTsRuntimeModelBinding
}))
vi.mock('../../src/renderer/src/lib/ipc/ts-runtime-text-eligibility', () => ({
  assessTsRuntimeTextEligibility
}))

import { compressMessages } from '../../src/renderer/src/lib/agent/context-compression'

const provider: ProviderConfig = {
  type: 'openai-chat',
  apiKey: 'secret',
  providerId: 'provider',
  model: 'model',
  sessionId: 'compression-session'
}

function stream(
  events: readonly Record<string, unknown>[]
): AsyncIterable<Record<string, unknown>> {
  return (async function* () {
    for (const event of events) yield event
  })()
}

function message(id: string, role: UnifiedMessage['role'], content: string): UnifiedMessage {
  return { id, role, content, createdAt: Number(id.replace(/\D/g, '')) || 1 }
}

describe('TS-first context compression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('summarizes through TS Runtime and preserves the compact boundary contract', async () => {
    isTsRuntimeAvailable.mockResolvedValue(true)
    resolveTsRuntimeModelBinding.mockReturnValue({
      workspaceId: 'local-personal',
      modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' }
    })
    assessTsRuntimeTextEligibility.mockReturnValue({ eligible: true, modelOptions: {} })
    streamTsRuntimeTextTurn.mockReturnValue(
      stream([
        { type: 'text_delta', text: '<think>omit</think>Keep the files and test result.' },
        { type: 'loop_end' }
      ])
    )

    const result = await compressMessages(
      [
        message('m1', 'user', 'Fix the workspace sync bug.'),
        message('m2', 'assistant', 'I changed sync-engine.ts.'),
        message('m3', 'user', 'Run the tests.'),
        message('m4', 'assistant', 'All tests pass.')
      ],
      provider,
      undefined,
      1,
      undefined,
      'Keep the rollback constraint.',
      'auto',
      1234
    )

    expect(streamTsRuntimeTextTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'local-personal',
        sessionId: 'compression-session',
        maxTurns: 1,
        prompt: expect.stringContaining('Fix the workspace sync bug.'),
        modelOptions: expect.objectContaining({
          systemPrompt: expect.any(String),
          responsesSessionScope: 'context-compression',
          temperature: 0
        })
      })
    )
    expect(result.result).toMatchObject({
      compressed: true,
      originalCount: 4,
      newCount: 3,
      messagesSummarized: 3
    })
    expect(result.messages[0]).toMatchObject({
      role: 'system',
      content: 'Conversation compacted',
      meta: {
        compactBoundary: {
          trigger: 'auto',
          preTokens: 1234,
          messagesSummarized: 3,
          preservedSegment: { headId: 'm4' }
        }
      }
    })
    expect(result.messages[1]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Keep the files and test result.'),
      meta: { compactSummary: { messagesSummarized: 3, recentMessagesPreserved: true } }
    })
    expect(result.messages.at(-1)?.id).toBe('m4')
  })

  it('moves a tool pair together instead of splitting tool_use from tool_result', async () => {
    isTsRuntimeAvailable.mockResolvedValue(true)
    resolveTsRuntimeModelBinding.mockReturnValue({
      workspaceId: 'local-personal',
      modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' }
    })
    assessTsRuntimeTextEligibility.mockReturnValue({ eligible: true, modelOptions: {} })
    streamTsRuntimeTextTurn.mockReturnValue(stream([{ type: 'text_delta', text: 'safe summary' }]))

    const messages: UnifiedMessage[] = [
      message('m1', 'user', 'Inspect the project.'),
      {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } }],
        createdAt: 2
      },
      {
        id: 'm3',
        role: 'assistant',
        content: 'Reading the source now.',
        createdAt: 3
      },
      message('m4', 'assistant', 'The file is ready.'),
      {
        id: 'm5',
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tool-1', content: 'source' }],
        createdAt: 5
      },
      message('m6', 'user', 'Continue.')
    ]

    const result = await compressMessages(
      messages,
      provider,
      undefined,
      2,
      undefined,
      undefined,
      'manual'
    )

    expect(result.result.compressed).toBe(true)
    expect(result.result.messagesSummarized).toBe(1)
    expect(result.messages.at(-1)?.id).toBe('m6')
    expect(streamTsRuntimeTextTurn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.not.stringContaining('[Tool result]') })
    )
  })

  it('fails closed when TS Runtime is unavailable', async () => {
    isTsRuntimeAvailable.mockResolvedValue(false)

    await expect(
      compressMessages(
        [
          message('m1', 'user', 'Task'),
          message('m2', 'assistant', 'Work'),
          message('m3', 'user', 'Next')
        ],
        provider,
        undefined,
        1
      )
    ).rejects.toThrow('TS_RUNTIME_COMPRESSION_UNAVAILABLE')

    expect(streamTsRuntimeTextTurn).not.toHaveBeenCalled()
  })

  it('reports a model error without calling an unavailable IPC fallback', async () => {
    isTsRuntimeAvailable.mockResolvedValue(true)
    resolveTsRuntimeModelBinding.mockReturnValue({
      workspaceId: 'local-personal',
      modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' }
    })
    assessTsRuntimeTextEligibility.mockReturnValue({ eligible: true, modelOptions: {} })
    streamTsRuntimeTextTurn.mockReturnValue(stream([{ type: 'error', error: 'model failed' }]))

    await expect(compressMessages([message('m1', 'user', 'Task')], provider)).rejects.toBe(
      'model failed'
    )
  })
})
