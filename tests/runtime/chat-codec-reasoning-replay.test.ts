import { describe, expect, it } from 'vitest'
import type { ModelInput } from '../../src/shared/runtime/model'
import type { ModelTarget } from '../../src/runtime/providers/transport'
import { chatCodec } from '../../src/runtime/providers/chat-codec'

const toolRound = [
  {
    role: 'assistant',
    text: '我来读取文件',
    reasoning: '需要先调用 Read 工具',
    toolCalls: [{ id: 'call-1', name: 'Read', input: { path: '/tmp/demo.txt' } }]
  },
  { role: 'tool', results: [{ id: 'call-1', name: 'Read', output: 'HELLO-OLA' }] }
]

function encode(options: Record<string, unknown>, messages: unknown[] = toolRound) {
  const input = {
    run: { workspaceId: 'workspace' },
    messages,
    tools: [],
    signal: new AbortController().signal
  } as unknown as ModelInput
  const target = {
    protocol: 'openai-chat',
    model: 'deepseek-flash',
    options
  } as unknown as ModelTarget
  const request = chatCodec.encode(input, target)
  return (request.body as { messages: Record<string, unknown>[] }).messages
}

describe('chat codec reasoning replay', () => {
  it('replays reasoning_content on an assistant tool-call message in thinking mode', () => {
    const messages = encode({ bodyOverrides: { thinking: { type: 'enabled' } } })
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      reasoning_content: '需要先调用 Read 工具',
      tool_calls: [{ id: 'call-1' }]
    })
    expect(messages[1]).toMatchObject({ role: 'tool', content: 'HELLO-OLA' })
  })

  it('sends an empty reasoning_content when thinking was requested but no text was emitted', () => {
    const messages = encode({ thinking: { type: 'enabled' } }, [
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'call-2', name: 'LS', input: {} }]
      },
      { role: 'tool', results: [{ id: 'call-2', name: 'LS', output: '[]' }] }
    ])
    expect(messages[0].reasoning_content).toBe('')
  })

  it('replays reasoning text even without explicit thinking overrides', () => {
    const messages = encode({})
    expect(messages[0].reasoning_content).toBe('需要先调用 Read 工具')
  })

  it('does not add a provider-specific field to a normal request', () => {
    const messages = encode({}, [
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '你好', toolCalls: [] }
    ])
    expect(messages[0].reasoning_content).toBeUndefined()
    expect(messages[1].reasoning_content).toBeUndefined()
  })
})
