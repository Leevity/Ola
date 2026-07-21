export interface TextContentBlock {
  type: 'text'
  text: string
}

export interface ImageContentBlock {
  type: 'image'
  source: {
    type: 'base64' | 'url'
    mediaType?: string
    data?: string
    url?: string
    filePath?: string
  }
}

export type ImageErrorCode = 'timeout' | 'network' | 'request_aborted' | 'api_error' | 'unknown'

export interface ImageErrorContentBlock {
  type: 'image_error'
  code: ImageErrorCode
  message: string
}

export type AgentErrorCode = 'runtime_error' | 'tool_error' | 'unknown'

export interface AgentErrorContentBlock {
  type: 'agent_error'
  code: AgentErrorCode
  message: string
  errorType?: string
  details?: string
  stackTrace?: string
}

export type OpenAIComputerActionType =
  | 'click'
  | 'double_click'
  | 'scroll'
  | 'keypress'
  | 'type'
  | 'wait'
  | 'screenshot'

export interface ToolCallExtraContent {
  google?: { thought_signature?: string }
  openaiResponses?: {
    computerUse?: {
      kind: 'computer_use'
      computerCallId: string
      computerActionType: OpenAIComputerActionType
      computerActionIndex: number
      autoAddedScreenshot?: boolean
    }
  }
}

export interface ToolUseContentBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  extraContent?: ToolCallExtraContent
}

export type ToolResultContent = string | Array<TextContentBlock | ImageContentBlock>

export interface ToolResultContentBlock {
  type: 'tool_result'
  toolUseId: string
  content: ToolResultContent
  isError?: boolean
}

export interface ThinkingContentBlock {
  type: 'thinking'
  thinking: string
  encryptedContent?: string
  encryptedContentProvider?: 'anthropic' | 'openai-responses' | 'google'
  startedAt?: number
  completedAt?: number
}

/** Stable extension envelope so unknown payloads remain distinguishable and round-trippable. */
export interface ExtensionContentBlock {
  type: 'extension'
  kind: string
  data: Record<string, unknown>
}

export type CanonicalContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ImageErrorContentBlock
  | AgentErrorContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ThinkingContentBlock
  | ExtensionContentBlock

export function isCanonicalContentBlock(value: unknown): value is CanonicalContentBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const type = (value as { type?: unknown }).type
  return (
    type === 'text' ||
    type === 'image' ||
    type === 'image_error' ||
    type === 'agent_error' ||
    type === 'tool_use' ||
    type === 'tool_result' ||
    type === 'thinking' ||
    type === 'extension'
  )
}

export function normalizeMessageContent(
  content: string | CanonicalContentBlock[]
): CanonicalContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}
