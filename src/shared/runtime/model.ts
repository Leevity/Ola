import type { RunSpec } from './contracts'

export type ModelProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini'
  | 'vertex-ai'
export interface ModelImage {
  mimeType: string
  data?: string
  url?: string
  assetId?: string
}
export interface ModelToolCall {
  id: string
  name: string
  input: unknown
  /** Provider-signed replay metadata; never interpreted as a credential or instruction. */
  signature?: string
}
export interface ModelToolResult {
  id: string
  name: string
  output: unknown
  images?: ModelImage[]
  isError?: boolean
}
export interface ProviderReplay {
  protocol: ModelProtocol
  items: Record<string, unknown>[]
  responseId?: string
}
export type AgentMessage =
  | { role: 'system' | 'user'; text: string; images?: ModelImage[] }
  | { role: 'assistant'; text: string; toolCalls: ModelToolCall[]; replay?: ProviderReplay }
  | { role: 'tool'; results: ModelToolResult[] }
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
}
export type ModelDelta =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; call: ModelToolCall }
  | { type: 'tool.start'; id: string; name: string }
  | { type: 'tool.arguments'; id: string; delta: string }
  | { type: 'replay'; replay: ProviderReplay }
  | ({ type: 'usage' } & ModelUsage)
export interface ModelTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
export interface ModelInput {
  run: RunSpec
  messages: readonly AgentMessage[]
  tools: ModelTool[]
  signal: AbortSignal
}
export interface ProviderAdapter {
  stream(input: ModelInput): AsyncIterable<ModelDelta>
}

/** Non-secret request configuration. Authentication remains in the transport host. */
export interface ModelOptions {
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  reasoningEffort?: string
  thinking?: { type: 'enabled'; budgetTokens: number } | { type: 'adaptive' } | { type: 'disabled' }
  thinkingLevel?: string
  enablePromptCache?: boolean
  cacheTtl?: '5m' | '1h'
  serviceTier?: string
  promptCacheKey?: string
  responsesSessionScope?: string
  bodyOverrides?: Record<string, unknown>
  omitBodyKeys?: string[]
}
