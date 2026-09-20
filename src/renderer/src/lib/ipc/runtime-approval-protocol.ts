import type { ToolCallState } from '../agent/types'
import { summarizeToolInputForHistory } from '../tools/tool-input-sanitizer'

export interface RuntimeApprovalRequest {
  runId?: string
  sessionId?: string
  toolCall: ToolCallState
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function normalizeRuntimeApprovalRequest(rawValue: unknown): RuntimeApprovalRequest | null {
  const value = record(rawValue)
  const toolCall = record(value.toolCall)
  const id = typeof toolCall.id === 'string' ? toolCall.id : ''
  const name = typeof toolCall.name === 'string' ? toolCall.name : ''
  if (!id || !name) return null

  return {
    runId: typeof value.runId === 'string' ? value.runId : undefined,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    toolCall: {
      id,
      name,
      input: summarizeToolInputForHistory(name, record(toolCall.input)),
      status: 'pending_approval',
      requiresApproval: true,
      startedAt: Number(toolCall.startedAt ?? Date.now())
    }
  }
}
