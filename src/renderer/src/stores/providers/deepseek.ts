import type { BuiltinProviderPreset } from './types'

export const deepseekPreset: BuiltinProviderPreset = {
  builtinId: 'deepseek',
  name: 'DeepSeek',
  type: 'anthropic',
  defaultBaseUrl: 'https://api.deepseek.com/anthropic',
  homepage: 'https://platform.deepseek.com',
  apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  defaultEnabled: true,
  defaultModel: 'deepseek-v4-flash',
  defaultModels: [
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.14,
      outputPrice: 0.28,
      cacheCreationPrice: 0.14,
      cacheHitPrice: 0.0028,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        disabledBodyParams: { enable_thinking: false }
      }
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.435,
      outputPrice: 0.87,
      cacheCreationPrice: 0.435,
      cacheHitPrice: 0.003625,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        disabledBodyParams: { enable_thinking: false }
      }
    },
    {
      id: 'deepseek-chat',
      name: 'DeepSeek V4 Flash (Chat, Deprecated)',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.14,
      outputPrice: 0.28,
      cacheCreationPrice: 0.14,
      cacheHitPrice: 0.0028
    },
    {
      id: 'deepseek-reasoner',
      name: 'DeepSeek V4 Flash (Reasoner, Deprecated)',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.14,
      outputPrice: 0.28,
      cacheCreationPrice: 0.14,
      cacheHitPrice: 0.0028,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    }
  ],
  deprecatedModelIds: ['deepseek-chat', 'deepseek-reasoner']
}
