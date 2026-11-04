import type {
  UnifiedMessage,
  TokenUsage,
  ToolResultContent,
  RequestDebugInfo,
  RequestTiming,
  ImageBlock,
  ImageErrorCode,
  ToolCallExtraContent
} from '../api/types'

// --- Tool Call Runtime State ---

export type ToolCallStatus =
  | 'streaming'
  | 'pending_approval'
  | 'running'
  | 'completed'
  | 'error'
  | 'canceled'

export interface ToolCallState {
  id: string
  name: string
  input: Record<string, unknown>
  status: ToolCallStatus
  output?: ToolResultContent
  error?: string
  requiresApproval: boolean
  extraContent?: ToolCallExtraContent
  sessionId?: string
  startedAt?: number
  completedAt?: number
}

// --- Request Retry State ---

export interface RequestRetryState {
  attempt: number
  maxAttempts: number
  delayMs: number
  statusCode?: number
  reason: string
}

// --- Agent Loop Events ---

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | {
      type: 'thinking_encrypted'
      thinkingEncryptedContent: string
      thinkingEncryptedProvider: 'anthropic' | 'openai-responses' | 'google'
    }
  | { type: 'translation_buffer_update'; content: string }
  | { type: 'image_generation_started' }
  | { type: 'image_generation_partial'; imageBlock: ImageBlock; partialImageIndex?: number }
  | { type: 'image_generated'; imageBlock: ImageBlock }
  | { type: 'image_error'; imageError: { code: ImageErrorCode; message: string } }
  | {
      type: 'message_end'
      usage?: TokenUsage
      timing?: RequestTiming
      providerResponseId?: string
      stopReason?: string
    }
  | {
      type: 'tool_use_streaming_start'
      toolCallId: string
      toolName: string
      toolCallExtraContent?: ToolCallExtraContent
    }
  | { type: 'tool_use_args_delta'; toolCallId: string; partialInput: Record<string, unknown> }
  | {
      type: 'tool_use_generated'
      toolUseBlock: {
        id: string
        name: string
        input: Record<string, unknown>
        extraContent?: ToolCallExtraContent
      }
    }
  | { type: 'tool_call_start'; toolCall: ToolCallState }
  | { type: 'tool_call_update'; toolCall: ToolCallState }
  | { type: 'tool_call_approval_needed'; toolCall: ToolCallState }
  | { type: 'tool_call_result'; toolCall: ToolCallState }
  | ({ type: 'request_retry' } & RequestRetryState)
  | {
      type: 'iteration_end'
      stopReason: string
      toolResults?: { toolUseId: string; content: ToolResultContent; isError?: boolean }[]
    }
  | {
      type: 'loop_end'
      reason: 'completed' | 'max_iterations' | 'aborted' | 'error'
      messages?: UnifiedMessage[]
    }
  | {
      type: 'error'
      error: Error
      errorType?: string
      details?: string
      stackTrace?: string
    }
  | { type: 'request_debug'; debugInfo: RequestDebugInfo }
  | { type: 'context_compression_start' }
  | {
      type: 'context_compressed'
      originalCount: number
      newCount: number
      /** Number of older messages that were summarized (kept visible in UI under the new model). */
      keptMessageCount?: number
      compactArtifacts?: UnifiedMessage[]
      messages?: UnifiedMessage[]
    }

// --- Agent Loop Stop Reasons ---

export type LoopEndReason = 'completed' | 'max_iterations' | 'aborted' | 'error'
