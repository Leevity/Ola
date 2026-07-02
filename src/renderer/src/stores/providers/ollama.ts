import type { BuiltinProviderPreset } from './types'

export const ollamaPreset: BuiltinProviderPreset = {
  builtinId: 'ollama',
  name: 'Ollama',
  type: 'openai-chat',
  defaultBaseUrl: 'http://localhost:11434/v1',
  homepage: 'https://ollama.com',
  apiKeyUrl: 'https://ollama.com/download',
  defaultModels: [],
  requiresApiKey: false
}
