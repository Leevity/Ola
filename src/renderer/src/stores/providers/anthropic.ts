import type { BuiltinProviderPreset } from './types'

export const anthropicPreset: BuiltinProviderPreset = {
  builtinId: 'anthropic',
  name: 'Anthropic',
  type: 'anthropic',
  defaultBaseUrl: 'https://api.anthropic.com',
  homepage: 'https://anthropic.com',
  apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  defaultModels: [
    // Claude Sonnet 5 (latest Sonnet — adaptive thinking, 1M context)
    {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 10,
      cacheCreationPrice: 2.5,
      cacheHitPrice: 0.2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    // Claude 4.8 (latest flagship — adaptive thinking, 1M context)
    {
      id: 'claude-opus-4-8',
      name: 'Claude Opus 4.8',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    // Claude 4.7 (previous flagship, now legacy)
    {
      id: 'claude-opus-4-7',
      name: 'Claude Opus 4.7',
      icon: 'claude',
      type: 'anthropic',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    // Claude 4.6 series (adaptive thinking, 1M context)
    {
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 3,
      outputPrice: 15,
      cacheCreationPrice: 3.75,
      cacheHitPrice: 0.3,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-sonnet-4-5-20250929',
      name: 'Claude Sonnet 4.5',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 3,
      outputPrice: 15,
      cacheCreationPrice: 3.75,
      cacheHitPrice: 0.3,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-haiku-4-5-20251001',
      name: 'Claude Haiku 4.5',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1,
      outputPrice: 5,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.1,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 8000 } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'claude-opus-4-5-20251101',
      name: 'Claude Opus 4.5',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    // Claude 4 series (legacy pricing)
    {
      id: 'claude-sonnet-4-20250514',
      name: 'Claude Sonnet 4',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 3,
      outputPrice: 15,
      cacheCreationPrice: 3.75,
      cacheHitPrice: 0.3,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
          thinking: { type: 'enabled', budget_tokens: 10000 }
        },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-opus-4-20250514',
      name: 'Claude Opus 4',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 15,
      outputPrice: 75,
      cacheCreationPrice: 18.75,
      cacheHitPrice: 1.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-3-5-haiku-20241022',
      name: 'Claude 3.5 Haiku',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 8_192,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.8,
      outputPrice: 4,
      cacheCreationPrice: 1,
      cacheHitPrice: 0.08,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 8000 } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    }
  ]
}
