import type { BuiltinProviderPreset } from './types'

export const copilotOAuthPreset: BuiltinProviderPreset = {
  builtinId: 'copilot-oauth',
  name: 'GitHub Copilot (OAuth)',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.githubcopilot.com',
  homepage: 'https://github.com/features/copilot',
  requiresApiKey: false,
  authMode: 'oauth',
  defaultModel: 'gpt-5-mini',
  useSystemProxy: true,
  userAgent: 'GitHubCopilotChat/0.26.7',
  oauthConfig: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    deviceCodeUrl: 'https://github.com/login/device/code',
    tokenExchangeUrl: 'https://api.github.com/copilot_internal/v2/token',
    clientId: 'Iv1.b507a08c87ecfe98',
    clientIdLocked: true,
    scope: 'read:user copilot',
    flowType: 'device_code',
    host: 'https://github.com',
    apiHost: 'https://api.github.com',
    useSystemProxy: true,
    tokenRequestHeaders: {
      Accept: 'application/json'
    },
    refreshRequestHeaders: {
      Accept: 'application/json'
    },
    deviceCodeRequestHeaders: {
      Accept: 'application/json'
    },
    usePkce: false
  },
  requestOverrides: {
    headers: {
      'Copilot-Integration-Id': 'vscode-chat',
      'editor-version': 'vscode/1.105.0',
      'editor-plugin-version': 'copilot-chat/0.26.7'
    }
  },
  deprecatedModelIds: ['gpt-5-codex', 'gpt-5.1-codex', 'gpt-5.1-codex-mini'],
  ui: { hideOAuthSettings: false },
  defaultModels: [
    {
      id: 'gpt-5-mini',
      name: 'GPT-5 Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.25,
      outputPrice: 2,
      cacheCreationPrice: 0.25,
      cacheHitPrice: 0.025,
      premiumRequestMultiplier: 0,
      availablePlans: ['free', 'pro', 'pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 8,
      cacheCreationPrice: 2,
      cacheHitPrice: 0.5,
      premiumRequestMultiplier: 0,
      availablePlans: ['pro', 'pro+', 'business', 'enterprise']
    },
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2.5,
      outputPrice: 10,
      cacheCreationPrice: 2.5,
      cacheHitPrice: 1.25,
      premiumRequestMultiplier: 0,
      availablePlans: ['pro', 'pro+', 'business', 'enterprise']
    },
    {
      id: 'gpt-5',
      name: 'GPT-5',
      icon: 'openai',
      enabled: true,
      type: 'openai-responses',
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      premiumRequestMultiplier: 1,
      availablePlans: ['pro', 'pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true
    },
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
      premiumRequestMultiplier: 3,
      availablePlans: ['pro', 'pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 3,
      outputPrice: 15,
      cacheCreationPrice: 3.75,
      cacheHitPrice: 0.3,
      premiumRequestMultiplier: 1,
      availablePlans: ['pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-sonnet-4-5-20250929',
      name: 'Claude Sonnet 4.5',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 3,
      outputPrice: 15,
      cacheCreationPrice: 3.75,
      cacheHitPrice: 0.3,
      premiumRequestMultiplier: 1,
      availablePlans: ['pro', 'pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } },
        forceTemperature: 1
      }
    },
    {
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      premiumRequestMultiplier: 3,
      availablePlans: ['pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 10,
      premiumRequestMultiplier: 1,
      availablePlans: ['pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' }
      }
    },
    {
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 2.5,
      premiumRequestMultiplier: 0.25,
      availablePlans: ['pro', 'pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' }
      }
    }
  ]
}
