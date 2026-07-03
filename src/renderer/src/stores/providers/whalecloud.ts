import type { BuiltinProviderPreset } from './types'

// 浩鲸云 GPT 代理服务，OpenAI Chat Completions 兼容协议
// 默认禁用，用户需在 UI 手动启用并填入 API Key 后才能使用
export const whalecloudPreset: BuiltinProviderPreset = {
  builtinId: 'whalecloud',
  name: '浩鲸云',
  type: 'openai-chat',
  defaultBaseUrl: 'https://lab.iwhalecloud.com/gpt-proxy/v1',
  homepage: 'https://lab.iwhalecloud.com',
  apiKeyUrl: 'https://lab.iwhalecloud.com',
  defaultEnabled: false,
  defaultModel: 'gpt-4o',
  defaultModels: [
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      icon: 'openai',
      enabled: false,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true
    },
    {
      id: 'gpt-4o-mini',
      name: 'GPT-4o Mini',
      icon: 'openai',
      enabled: false,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true
    }
  ]
}
