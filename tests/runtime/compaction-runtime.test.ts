import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig, UnifiedMessage } from '../../src/renderer/src/lib/api/types'

vi.mock('../../src/renderer/src/lib/ipc/messagepack-ipc-client', () => ({
  invokeMessagePackBinary: vi.fn(),
  invokeMessagePack: vi.fn()
}))
vi.mock('../../src/renderer/src/stores/agent-store', () => ({
  useAgentStore: { getState: () => ({}) }
}))

import {
  attachLiveCompactSummaryDisplayAnchor,
  extractCompactArtifactMessages,
  hasMeaningfulAssistantContent,
  shouldInsertCompressedMessagesBeforeAssistant
} from '../../src/renderer/src/lib/agent/compaction-runtime'
import {
  buildStreamingContextUsage,
  estimateContextTokensForRequest,
  findPersistedContextLength,
  normalizeUsageWithEstimatedContext
} from '../../src/renderer/src/lib/agent/context-usage'

function userMessage(id: string, content: string): UnifiedMessage {
  return { id, role: 'user', content, createdAt: 1 }
}

function assistantMessage(id: string, content: UnifiedMessage['content']): UnifiedMessage {
  return { id, role: 'assistant', content, createdAt: 2 }
}

function summaryMessage(id: string): UnifiedMessage {
  return {
    id,
    role: 'user',
    content: 'summary text',
    createdAt: 3,
    meta: { compactSummary: { messagesSummarized: 2, recentMessagesPreserved: true } }
  }
}

describe('compaction transcript helpers', () => {
  it('anchors the summary card to the live assistant turn', () => {
    const assistant = assistantMessage('assistant-a', [
      { type: 'text', text: 'thinking out loud' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }
    ])

    const { messages, anchored } = attachLiveCompactSummaryDisplayAnchor(
      [summaryMessage('summary-a')],
      assistant,
      'assistant-a'
    )

    expect(anchored).toBe(true)
    expect(messages[0].meta?.compactSummary?.displayAnchor).toEqual({
      assistantMessageId: 'assistant-a',
      afterContentBlockCount: 2,
      afterToolUseId: 'tool-1'
    })
  })

  it('leaves the summary unanchored when the assistant turn is still empty', () => {
    const assistant = assistantMessage('assistant-a', [])

    const { messages, anchored } = attachLiveCompactSummaryDisplayAnchor(
      [summaryMessage('summary-a')],
      assistant,
      'assistant-a'
    )

    expect(anchored).toBe(false)
    expect(messages[0].meta?.compactSummary?.displayAnchor).toBeUndefined()
  })

  it('inserts before an empty assistant placeholder that trails the transcript', () => {
    const messages = [userMessage('user-a', 'hi'), assistantMessage('assistant-a', '')]

    expect(shouldInsertCompressedMessagesBeforeAssistant(messages, 'assistant-a')).toBe(true)
  })

  it('keeps the summary at the bottom once the assistant produced content', () => {
    const messages = [
      userMessage('user-a', 'hi'),
      assistantMessage('assistant-a', [{ type: 'text', text: 'answer' }])
    ]

    expect(shouldInsertCompressedMessagesBeforeAssistant(messages, 'assistant-a')).toBe(false)
    expect(hasMeaningfulAssistantContent(messages[1])).toBe(true)
  })

  it('extracts exactly the boundary and summary artifacts', () => {
    const boundary: UnifiedMessage = {
      id: 'boundary',
      role: 'system',
      content: '',
      createdAt: 4,
      meta: {
        compactBoundary: {
          trigger: 'manual',
          preTokens: 100,
          messagesSummarized: 1,
          preservedSegment: { headId: 'm2', anchorId: 'summary-a', tailId: 'm2' }
        }
      }
    }
    const artifacts = extractCompactArtifactMessages([
      boundary,
      summaryMessage('summary-a'),
      userMessage('user-b', 'later')
    ])

    expect(artifacts.map((message) => message.id)).toEqual(['boundary', 'summary-a'])
    expect(extractCompactArtifactMessages(null)).toEqual([])
  })
})

describe('context usage accounting', () => {
  const provider = { type: 'openai-chat', model: 'test', maxTokens: 1000 } as ProviderConfig

  it('reads the newest persisted context window', () => {
    const messages: UnifiedMessage[] = [
      {
        ...userMessage('a', 'one'),
        usage: { inputTokens: 10, outputTokens: 1, contextLength: 8000 }
      },
      {
        ...userMessage('b', 'two'),
        usage: { inputTokens: 20, outputTokens: 2, contextLength: 16000 }
      }
    ]

    expect(findPersistedContextLength(messages)).toBe(16000)
    expect(findPersistedContextLength([userMessage('c', 'three')])).toBe(0)
  })

  it('estimates a request from messages and system prompt', () => {
    const messages = [userMessage('a', 'x'.repeat(4000))]
    const estimate = estimateContextTokensForRequest({
      messages,
      tools: [],
      providerConfig: provider
    })

    expect(estimate).toBeGreaterThan(0)
    expect(
      estimateContextTokensForRequest({ messages: [], tools: [], providerConfig: provider })
    ).toBe(0)
  })

  it('keeps the larger of reported and estimated context tokens', () => {
    const usage = { inputTokens: 100, outputTokens: 10 }
    const websocketDebug = {
      url: 'wss://example.test/v1',
      method: 'POST',
      headers: {},
      timestamp: 1,
      transport: 'websocket' as const,
      contextWindowBody: JSON.stringify({ model: 'test' })
    }

    expect(
      normalizeUsageWithEstimatedContext({
        usage,
        contextLength: 32000,
        debugInfo: websocketDebug,
        estimatedContextTokens: 500
      })
    ).toMatchObject({ contextTokens: 500, contextLength: 32000 })

    // A plain HTTP request has no estimated payload, so the reported value wins.
    expect(
      normalizeUsageWithEstimatedContext({ usage, estimatedContextTokens: 500 }).contextTokens
    ).toBe(100)
  })

  it('builds a provisional streaming usage only for a positive window', () => {
    expect(buildStreamingContextUsage(0, 1000)).toBeNull()
    expect(buildStreamingContextUsage(1200, 32000)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 1200,
      contextLength: 32000
    })
  })
})
