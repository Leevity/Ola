import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '../../src/renderer/src/lib/api/types'
import {
  RESPONSES_SESSION_SCOPE_PROMPT_RECOMMENDATION,
  withAuxiliaryResponsesRequestPolicy
} from '../../src/renderer/src/lib/api/responses-session-policy'
import { assessTsRuntimeTextEligibility } from '../../src/renderer/src/lib/ipc/ts-runtime-text-eligibility'

// The shape a composer recommendation asks for: a 256-token budget on a reasoning model.
const reasoningProvider: ProviderConfig = {
  type: 'openai-chat',
  apiKey: 'secret',
  model: 'deepseek-flash',
  providerId: 'provider',
  maxTokens: 256,
  temperature: 0.2,
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  thinkingConfig: { bodyParams: { thinking: { type: 'enabled', budget_tokens: 4096 } } }
}

describe('Auxiliary text request policy', () => {
  it('takes reasoning out of the request on every protocol so a small budget still returns text', () => {
    const applied = withAuxiliaryResponsesRequestPolicy(
      reasoningProvider,
      RESPONSES_SESSION_SCOPE_PROMPT_RECOMMENDATION
    )

    expect(applied.thinkingEnabled).toBe(false)
    expect(applied.reasoningEffort).toBeUndefined()
    expect(applied.responsesSessionScope).toBeUndefined()

    const eligibility = assessTsRuntimeTextEligibility({
      messages: [{ id: 'one', role: 'user', content: 'next step?', createdAt: 1 }],
      provider: applied,
      modelSource: { kind: 'local', providerId: 'provider', modelId: 'deepseek-flash' }
    })
    if (!eligibility.eligible) throw new Error(eligibility.reason)
    expect(eligibility.modelOptions).toMatchObject({ maxTokens: 256 })
    expect(eligibility.modelOptions).not.toHaveProperty('reasoningEffort')
    expect(eligibility.modelOptions).not.toHaveProperty('thinking')
    expect(eligibility.modelOptions).not.toHaveProperty('bodyOverrides')
  })

  it('keeps the bounded Responses session scope and websocket reuse for that protocol', () => {
    const applied = withAuxiliaryResponsesRequestPolicy(
      { ...reasoningProvider, type: 'openai-responses' },
      'generate-title'
    )

    expect(applied).toMatchObject({
      responsesSessionScope: 'generate-title',
      websocketMode: 'disabled',
      thinkingEnabled: false
    })
    expect(applied.reasoningEffort).toBeUndefined()
  })
})
