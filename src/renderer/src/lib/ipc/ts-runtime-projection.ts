import type { StreamEvent, TokenUsage } from '@renderer/lib/api/types'
import type {
  PendingRuntimeInteraction,
  RunEvent,
  RunStatus
} from '../../../../shared/runtime/contracts'

export interface TsRuntimeInteractionEvent {
  type: 'runtime_interaction_requested'
  interaction: PendingRuntimeInteraction
}

/**
 * Runtime snapshots are delivered in small, independently projected batches.
 * Keep only the public tool-call fields needed to join `tool.generated` to a
 * later `tool.result`; credentials and provider replay metadata never enter
 * this renderer state.
 */
export interface TsRuntimeProjectionState {
  toolCalls: Map<string, { name: string; input: Record<string, unknown> }>
}

export function createTsRuntimeProjectionState(): TsRuntimeProjectionState {
  return { toolCalls: new Map() }
}

/** The subset of existing chat events emitted by the TS runtime projection. */
export type TsRuntimeProjectedEvent =
  | StreamEvent
  | TsRuntimeInteractionEvent
  | { type: 'loop_end'; reason: 'completed' }
  | {
      type: 'tool_use_generated'
      toolUseBlock: { id: string; name: string; input: Record<string, unknown> }
    }
  | {
      type: 'tool_call_result'
      toolCall: {
        id: string
        name: string
        input: Record<string, unknown>
        status: 'completed' | 'error'
        output: string
        error?: string
        requiresApproval: false
        completedAt: number
      }
    }

function usage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (typeof item.inputTokens !== 'number' || typeof item.outputTokens !== 'number')
    return undefined
  return {
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    ...(typeof item.cacheReadTokens === 'number' ? { cacheReadTokens: item.cacheReadTokens } : {}),
    ...(typeof item.cacheCreationTokens === 'number'
      ? { cacheCreationTokens: item.cacheCreationTokens }
      : {}),
    ...(typeof item.reasoningTokens === 'number' ? { reasoningTokens: item.reasoningTokens } : {})
  }
}

/** Preserves the persisted interaction identity so its response can be scoped to this run. */
export function projectTsRuntimeInteraction(
  interaction: PendingRuntimeInteraction
): TsRuntimeInteractionEvent {
  return { type: 'runtime_interaction_requested', interaction }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function toolOutput(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return 'TOOL_RESULT_UNAVAILABLE'
  }
}

function imageBlocks(value: unknown): Array<{
  type: 'image'
  source: { type: 'base64'; mediaType: string; filePath: string }
}> {
  const item = record(value)
  if (!item || item.__olaImageResult !== true || !Array.isArray(item.images)) return []
  return item.images.flatMap((image) => {
    const row = record(image)
    return typeof row?.filePath === 'string' && row.filePath.trim()
      ? [
          {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              mediaType: typeof row.mediaType === 'string' ? row.mediaType : 'image/png',
              filePath: row.filePath
            }
          }
        ]
      : []
  })
}

/** Projects persisted TS runtime events into the existing provider-stream vocabulary. */
export function projectTsRuntimeEvents(
  events: readonly RunEvent[],
  state: TsRuntimeProjectionState = createTsRuntimeProjectionState()
): TsRuntimeProjectedEvent[] {
  const output: TsRuntimeProjectedEvent[] = []
  for (const event of events) {
    const data = record(event.data)
    if (event.type === 'run.status' && data?.status === 'running') {
      output.push({ type: 'message_start' })
    } else if (event.type === 'message.delta' && typeof data?.text === 'string') {
      output.push({ type: 'text_delta', text: data.text })
    } else if (event.type === 'thinking.delta' && typeof data?.text === 'string') {
      output.push({ type: 'thinking_delta', thinking: data.text })
    } else if (event.type === 'message.completed') {
      output.push({ type: 'message_end', usage: usage(data?.usage) })
    } else if (event.type === 'run.status' && data?.status === 'completed') {
      // The renderer's full Agent flow expects a loop terminal event to commit a
      // successful run. The scheduler persists completion separately from the
      // final provider message, so preserve both events rather than treating a
      // cleanly exhausted stream as an error.
      output.push({ type: 'loop_end', reason: 'completed' })
    } else if (
      event.type === 'tool.generated' &&
      typeof data?.id === 'string' &&
      typeof data.name === 'string' &&
      record(data.input)
    ) {
      const input = record(data.input)!
      state.toolCalls.set(data.id, { name: data.name, input })
      output.push({
        type: 'tool_use_generated',
        toolUseBlock: { id: data.id, name: data.name, input }
      })
    } else if (
      event.type === 'tool.result' &&
      typeof data?.id === 'string' &&
      typeof data.name === 'string'
    ) {
      const failed = data.isError === true
      const outputValue = toolOutput(data.output)
      if (!failed && data.name === 'ImageGenerate') {
        for (const imageBlock of imageBlocks(data.output))
          output.push({ type: 'image_generated', imageBlock })
      }
      const generated = state.toolCalls.get(data.id)
      // A result can be recovered after reconnect without its earlier event
      // batch. Preserve the result in that case, but never invent an input.
      const input = generated?.name === data.name ? generated.input : {}
      state.toolCalls.delete(data.id)
      output.push({
        type: 'tool_call_result',
        toolCall: {
          id: data.id,
          name: data.name,
          input,
          status: failed ? 'error' : 'completed',
          output: outputValue,
          ...(failed ? { error: outputValue } : {}),
          requiresApproval: false,
          completedAt: event.timestamp
        }
      })
    } else if (
      event.type === 'run.status' &&
      (data?.status === 'failed' || data?.status === 'interrupted')
    ) {
      output.push({
        type: 'error',
        error: {
          type: typeof data.reason === 'string' ? data.reason : 'RUNTIME_FAILED',
          message: 'TS runtime execution failed.'
        }
      })
    } else if (event.type === 'run.status' && data?.status === 'cancelled') {
      output.push({
        type: 'error',
        error: {
          type: 'RUN_CANCELLED',
          message: 'TS runtime execution was cancelled.'
        }
      })
    }
  }
  return output
}

export function isTerminalTsRuntimeStatus(status: RunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  )
}
