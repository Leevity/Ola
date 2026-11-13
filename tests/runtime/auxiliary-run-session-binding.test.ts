import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ProviderConfig,
  StreamEvent,
  UnifiedMessage
} from '../../src/renderer/src/lib/api/types'

const runtime = vi.hoisted(() => ({
  turns: [] as Array<{ workspaceId: string; sessionId: string }>,
  sessions: [] as Array<{ id: string; workspaceId?: string; updatedAt: number }>,
  activeSessionId: null as string | null
}))

vi.mock('../../src/renderer/src/lib/ipc/ts-runtime-bridge', () => ({
  isTsRuntimeAvailable: async () => true,
  streamTsRuntimeTextTurn: async function* (input: { workspaceId: string; sessionId: string }) {
    runtime.turns.push(input)
    yield { type: 'text_delta', text: 'A generated title' }
    yield { type: 'loop_end' }
  }
}))

vi.mock('../../src/renderer/src/lib/ipc/ts-runtime-model-binding', () => ({
  resolveTsRuntimeModelBinding: () => ({
    workspaceId: 'business-workspace',
    modelSource: { kind: 'local', providerId: 'fixture', modelId: 'fixture-model' }
  })
}))

vi.mock('@renderer/stores/chat-store', () => ({
  useChatStore: {
    getState: () => ({ sessions: runtime.sessions, activeSessionId: runtime.activeSessionId })
  }
}))

import { runTsTextRequest, streamTsProviderTurn } from '../../src/renderer/src/lib/ipc/agent-bridge'
import { resolveAuxiliaryRunSessionId } from '../../src/renderer/src/lib/ipc/auxiliary-run-session'

const provider: ProviderConfig = {
  type: 'openai-chat',
  apiKey: 'fixture',
  model: 'fixture-model'
}

const messages: UnifiedMessage[] = [
  { id: 'aux-user', role: 'user', content: 'Name this conversation.', createdAt: 1 }
]

describe('auxiliary run session binding', () => {
  beforeEach(() => {
    runtime.turns.length = 0
    runtime.sessions = [
      { id: 'older-session', workspaceId: 'business-workspace', updatedAt: 10 },
      { id: 'newest-session', workspaceId: 'business-workspace', updatedAt: 20 },
      { id: 'other-workspace-session', workspaceId: 'another-workspace', updatedAt: 30 }
    ]
    runtime.activeSessionId = null
  })

  it('travels under the session the caller owns', async () => {
    const text = await runTsTextRequest({
      provider: { ...provider, sessionId: 'owning-session' },
      messages
    })

    expect(text).toBe('A generated title')
    expect(runtime.turns).toHaveLength(1)
    expect(runtime.turns[0]).toMatchObject({
      workspaceId: 'business-workspace',
      sessionId: 'owning-session'
    })
  })

  it('falls back to the active session of the run workspace, never a synthetic id', async () => {
    runtime.activeSessionId = 'older-session'

    await runTsTextRequest({ provider, messages })

    expect(runtime.turns[0].sessionId).toBe('older-session')
  })

  it('picks the most recently updated session when none is active', async () => {
    await expect(resolveAuxiliaryRunSessionId('business-workspace')).resolves.toBe('newest-session')
  })

  it('refuses to borrow a session from another workspace', async () => {
    runtime.sessions = [
      { id: 'other-workspace-session', workspaceId: 'another-workspace', updatedAt: 30 }
    ]

    await expect(runTsTextRequest({ provider, messages })).rejects.toThrow(
      'TS_RUNTIME_TEXT_SESSION_REQUIRED'
    )
    expect(runtime.turns).toHaveLength(0)
  })

  it('refuses when the workspace has no session at all', async () => {
    runtime.sessions = []

    await expect(resolveAuxiliaryRunSessionId('business-workspace')).resolves.toBeNull()
  })

  it('binds the provider-turn stream used by translate and prompt optimization', async () => {
    const events: StreamEvent[] = []
    for await (const event of streamTsProviderTurn({ provider, messages, tools: [] })) {
      events.push(event)
    }

    expect(runtime.turns).toHaveLength(1)
    expect(runtime.turns[0]).toMatchObject({
      workspaceId: 'business-workspace',
      sessionId: 'newest-session'
    })
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  it('reports a missing session on the provider-turn stream instead of submitting', async () => {
    runtime.sessions = []
    const events: StreamEvent[] = []
    for await (const event of streamTsProviderTurn({ provider, messages, tools: [] })) {
      events.push(event)
    }

    expect(runtime.turns).toHaveLength(0)
    expect(events).toEqual([
      {
        type: 'error',
        error: { type: 'ts_runtime_error', message: 'TS_RUNTIME_TEXT_SESSION_REQUIRED' }
      }
    ])
  })
})
