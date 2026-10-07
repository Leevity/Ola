import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../../src/renderer/src/lib/api/types'

const runtime = vi.hoisted(() => ({
  turns: [] as Array<{ workspaceId: string; sessionId: string; maxTurns?: number }>
}))

vi.mock('../../src/renderer/src/lib/ipc/ts-runtime-bridge', () => ({
  isTsRuntimeAvailable: async () => true,
  streamTsRuntimeTextTurn: async function* (input: {
    workspaceId: string
    sessionId: string
    maxTurns?: number
  }) {
    runtime.turns.push(input)
    yield {
      type: 'text_delta',
      text: JSON.stringify({ title: 'Completed', summary: 'Finished the task.' })
    }
  }
}))

vi.mock('../../src/renderer/src/lib/ipc/ts-runtime-model-binding', () => ({
  resolveTsRuntimeModelBinding: () => ({
    workspaceId: 'active-but-not-session-workspace',
    modelSource: { kind: 'local', providerId: 'fixture', modelId: 'fixture-model' }
  })
}))

import { generateFinalOutcome } from '../../src/renderer/src/lib/agent/final-outcome'

describe('final outcome runtime authorization', () => {
  it('runs its model summary in the owning business session and workspace', async () => {
    runtime.turns.length = 0
    const provider: ProviderConfig = {
      type: 'openai-chat',
      apiKey: 'fixture',
      model: 'fixture-model'
    }
    const outcome = await generateFinalOutcome({
      sessionId: 'business-session',
      workspaceId: 'business-workspace',
      goal: 'Finish the task',
      loopEndReason: 'completed',
      toolCalls: [],
      durationMs: 10,
      providers: [provider]
    })

    expect(outcome.source).toBe('model')
    expect(runtime.turns).toHaveLength(1)
    expect(runtime.turns[0]).toMatchObject({
      sessionId: 'business-session',
      workspaceId: 'business-workspace',
      maxTurns: 1
    })
  })
})
