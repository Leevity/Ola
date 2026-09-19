import { describe, expect, it } from 'vitest'
import type { ProviderConfig, UnifiedMessage } from '../../src/renderer/src/lib/api/types'
import {
  assessTsRuntimeTextEligibility,
  explicitTsRuntimeModelSource,
  supportsTsRuntimeAgentTools,
  supportsTsRuntimeReadOnlyTools
} from '../../src/renderer/src/lib/ipc/ts-runtime-text-eligibility'

const provider: ProviderConfig = {
  type: 'openai-chat',
  apiKey: 'secret',
  model: 'model',
  providerId: 'provider',
  systemPrompt: 'Be concise',
  temperature: 0
}
const messages: UnifiedMessage[] = [
  { id: 'one', role: 'assistant' as const, content: 'Earlier answer', createdAt: 1 },
  { id: 'two', role: 'user' as const, content: 'Current question', createdAt: 2 }
]

describe('TS runtime text eligibility', () => {
  it('projects only a lossless plain-text request and excludes provider secrets', () => {
    expect(
      assessTsRuntimeTextEligibility({
        messages,
        provider,
        modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' }
      })
    ).toEqual({
      eligible: true,
      prompt: 'Current question',
      history: [{ role: 'assistant', text: 'Earlier answer' }],
      modelOptions: { systemPrompt: 'Be concise', temperature: 0 }
    })
  })

  it('projects typed thinking options into the TS runtime request', () => {
    expect(
      assessTsRuntimeTextEligibility({
        messages,
        provider: {
          ...provider,
          thinkingEnabled: true,
          thinkingConfig: {
            bodyParams: { thinking: { type: 'enabled', budget_tokens: 2048 } },
            forceTemperature: 1
          }
        },
        modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' }
      })
    ).toMatchObject({
      eligible: true,
      modelOptions: {
        temperature: 1,
        thinking: { type: 'enabled', budgetTokens: 2048 },
        bodyOverrides: { thinking: { type: 'enabled', budget_tokens: 2048 } }
      }
    })
  })

  it('rejects thinking when the provider has no typed thinking configuration', () => {
    expect(
      assessTsRuntimeTextEligibility({
        messages,
        provider: { ...provider, thinkingEnabled: true },
        modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' }
      })
    ).toEqual({ eligible: false, reason: 'PROVIDER_OPTIONS_NOT_MIGRATED' })
  })

  it('rejects tool and rich-content transcript entries', () => {
    const toolMessages: UnifiedMessage[] = [{ ...messages[0], role: 'tool' }, messages[1]]
    const richMessages = [
      { ...messages[0], content: [{ type: 'text', text: 'rich' }] },
      messages[1]
    ] as unknown as UnifiedMessage[]
    for (const input of [toolMessages, richMessages]) {
      expect(
        assessTsRuntimeTextEligibility({
          messages: input,
          provider,
          modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' }
        })
      ).toEqual({ eligible: false, reason: 'MESSAGE_CONTENT_NOT_MIGRATED' })
    }
  })

  it('uses a typed session binding and never guesses a managed resource', () => {
    expect(
      explicitTsRuntimeModelSource({
        sessionModelSource: { kind: 'ola-team', workspaceId: 'team-a', resourceId: 'r' },
        modelId: 'ignored'
      })
    ).toEqual({ kind: 'ola-team', workspaceId: 'team-a', resourceId: 'r' })
    expect(
      explicitTsRuntimeModelSource({ providerId: 'ola-managed:team-a', modelId: 'r' })
    ).toBeNull()
  })

  it('only permits Main-owned compatible read tools with an explicit local root', () => {
    expect(
      supportsTsRuntimeReadOnlyTools({
        toolNames: ['Read', 'Grep', 'WebSearch'],
        workingDirectory: '/workspace'
      })
    ).toBe(true)
    expect(supportsTsRuntimeReadOnlyTools({ toolNames: ['Read'] })).toBe(false)
    expect(supportsTsRuntimeReadOnlyTools({ toolNames: ['WebFetch', 'MemorySearch'] })).toBe(false)
  })

  it('permits approved execute-tool equivalents only with a fixed working root', () => {
    expect(
      supportsTsRuntimeAgentTools({
        toolNames: ['Read', 'Write', 'Edit', 'Bash', 'Notify'],
        workingDirectory: '/workspace'
      })
    ).toBe(true)
    expect(supportsTsRuntimeAgentTools({ toolNames: ['Write'] })).toBe(false)
    expect(
      supportsTsRuntimeAgentTools({
        toolNames: ['mcp__docs__search'],
        workingDirectory: undefined
      })
    ).toBe(true)
    expect(
      supportsTsRuntimeAgentTools({
        toolNames: ['mcp__docs__not safe'],
        workingDirectory: undefined
      })
    ).toBe(false)
    expect(
      supportsTsRuntimeAgentTools({
        toolNames: ['extension__weather__lookup'],
        extensionToolNames: ['extension__weather__lookup']
      })
    ).toBe(true)
    expect(
      supportsTsRuntimeAgentTools({
        toolNames: ['extension__weather__script'],
        extensionToolNames: ['extension__weather__lookup']
      })
    ).toBe(false)
    expect(supportsTsRuntimeAgentTools({ toolNames: ['BrowserNavigate'] })).toBe(false)
  })
})
