import type { BuiltinProviderPreset } from './types'

// DeepSeek OpenAI 兼容 API:
// - base_url: https://api.deepseek.com
// - 鉴权: Authorization: Bearer <key>
// - 模型列表端点: GET /v1/models
// - 对话端点: POST /v1/chat/completions
// - thinking: { type: 'enabled' } + reasoning_effort: low|medium|high
//
// 2026-11-06 实测 GET /v1/models 只返回 `deepseek-flash`（DeepSeek-V4.1-Flash，1M 上下文，
// 支持图像输入）与 `deepseek-v4-pro`。旧的 `deepseek-v4-flash` 并不存在；`deepseek-chat` /
// `deepseek-reasoner` 已于 2026/07/24 弃用，服务端会静默重定向到 flash。三者都不再作为
// preset 模型下发，并列入 deprecatedModelIds 以便升级时从已保存配置中剔除。
export const deepseekPreset: BuiltinProviderPreset = {
  builtinId: 'deepseek',
  name: 'DeepSeek',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.deepseek.com/v1',
  homepage: 'https://platform.deepseek.com',
  apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  defaultEnabled: true,
  defaultModel: 'deepseek-flash',
  defaultModels: [
    {
      id: 'deepseek-flash',
      name: 'DeepSeek V4.1 Flash',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsVision: true,
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
    }
  ],
  deprecatedModelIds: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner']
}
