import type { BuiltinProviderPreset } from './types'

// DeepSeek OpenAI 兼容 API:
// - base_url: https://api.deepseek.com
// - 鉴权: Authorization: Bearer <key>
// - 模型列表端点: GET /v1/models (200, 返回 deepseek-v4-flash / deepseek-v4-pro)
// - 对话端点: POST /v1/chat/completions
// - thinking: { type: 'enabled' } + reasoning_effort: low|medium|high
// - deepseek-chat / deepseek-reasoner 2026/07/24 弃用，分别对应 flash 的非思考与思考模式
export const deepseekPreset: BuiltinProviderPreset = {
  builtinId: 'deepseek',
  name: 'DeepSeek',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.deepseek.com/v1',
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
        bodyParams: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
        disabledBodyParams: { thinking: { type: 'disabled' } }
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
        bodyParams: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
        disabledBodyParams: { thinking: { type: 'disabled' } }
      }
    },
    {
      // 官方: deepseek-chat 对应 deepseek-v4-flash 的非思考模式，2026/07/24 弃用
      id: 'deepseek-chat',
      name: 'DeepSeek Chat (Deprecated 2026-07-24)',
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
      supportsThinking: false
    },
    {
      // 官方: deepseek-reasoner 对应 deepseek-v4-flash 的思考模式，2026/07/24 弃用
      id: 'deepseek-reasoner',
      name: 'DeepSeek Reasoner (Deprecated 2026-07-24)',
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
        bodyParams: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
        disabledBodyParams: { thinking: { type: 'disabled' } }
      }
    }
  ],
  deprecatedModelIds: ['deepseek-chat', 'deepseek-reasoner']
}
