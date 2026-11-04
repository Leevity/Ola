import type { AgentEvent } from '@renderer/lib/agent/types'
import type { SubAgentEvent } from '@renderer/lib/agent/sub-agents/types'
import type { TsRuntimeProjectedEvent } from '@renderer/lib/ipc/ts-runtime-projection'
import { useAgentStore } from '@renderer/stores/agent-store'
import {
  appendRuntimeTextDelta,
  appendRuntimeThinkingDelta,
  updateRuntimeToolUseInput
} from '@renderer/lib/agent/session-runtime-router'
import {
  liveToolInputSignature,
  type LiveLineCountCache,
  summarizeToolInputForLiveCard
} from '@renderer/lib/tools/tool-input-sanitizer'
import { recordStreamingToolArgsDuration } from '@renderer/lib/streaming-perf'

/**
 * Streaming cadences. Text, thinking and tool-argument deltas arrive far faster
 * than the UI can commit, so each family has its own flush interval. Background
 * sessions are never visible, so they use the same cadence without the
 * foreground-specific live-card updates.
 */
export const STREAM_DELTA_FLUSH_MS = 300
export const BACKGROUND_STREAM_DELTA_FLUSH_MS = 300
export const TOOL_INPUT_FLUSH_MS = 300
export const AGENT_TOOL_INPUT_FLUSH_MS = 300
export const BACKGROUND_TOOL_INPUT_FLUSH_MS = 300
/** SubAgent text can arrive from multiple inner loops at high frequency. */
export const SUB_AGENT_TEXT_FLUSH_MS = 300

const COMMAND_TOOL_NAMES = new Set(['Bash', 'Shell', 'PowerShell'])

export interface StreamDeltaBuffer {
  pushThinking: (chunk: string) => void
  pushText: (chunk: string) => void
  setToolInput: (toolUseId: string, input: Record<string, unknown>) => void
  flushNow: () => void
  dispose: () => void
}

export interface LiveToolInputThrottleEntry {
  lastChatFlush: number
  lastAgentFlush: number
  pendingRaw?: Record<string, unknown>
  pendingSummary?: Record<string, unknown>
  pendingSignature?: string
  chatTimer?: ReturnType<typeof setTimeout>
  agentTimer?: ReturnType<typeof setTimeout>
  lastChatSent?: string
  lastAgentSent?: string
  lineCountCache: LiveLineCountCache
}

export function createStreamDeltaBuffer(
  sessionId: string,
  assistantMsgId: string,
  flushIntervalMs = STREAM_DELTA_FLUSH_MS,
  toolInputFlushIntervalMs = TOOL_INPUT_FLUSH_MS
): StreamDeltaBuffer {
  let thinkingBuffer = ''
  let textBuffer = ''
  const toolInputBuffer = new Map<string, Record<string, unknown>>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let toolInputTimer: ReturnType<typeof setTimeout> | null = null

  const flushToolInputs = (): void => {
    if (toolInputTimer) {
      clearTimeout(toolInputTimer)
      toolInputTimer = null
    }
    if (toolInputBuffer.size === 0) return
    for (const [toolUseId, input] of toolInputBuffer) {
      updateRuntimeToolUseInput(sessionId, assistantMsgId, toolUseId, input)
    }
    toolInputBuffer.clear()
  }

  const flushNow = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }

    if (!thinkingBuffer && !textBuffer && toolInputBuffer.size === 0) return

    if (thinkingBuffer) {
      appendRuntimeThinkingDelta(sessionId, assistantMsgId, thinkingBuffer)
      thinkingBuffer = ''
    }

    if (textBuffer) {
      appendRuntimeTextDelta(sessionId, assistantMsgId, textBuffer)
      textBuffer = ''
    }

    flushToolInputs()
  }

  const scheduleFlush = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      // Only flush text/thinking here; tool inputs follow their own cadence.
      if (thinkingBuffer) {
        appendRuntimeThinkingDelta(sessionId, assistantMsgId, thinkingBuffer)
        thinkingBuffer = ''
      }
      if (textBuffer) {
        appendRuntimeTextDelta(sessionId, assistantMsgId, textBuffer)
        textBuffer = ''
      }
    }, flushIntervalMs)
  }

  const scheduleToolInputFlush = (): void => {
    if (toolInputTimer) return
    toolInputTimer = setTimeout(() => {
      toolInputTimer = null
      flushToolInputs()
    }, toolInputFlushIntervalMs)
  }

  return {
    pushThinking: (chunk: string) => {
      if (!chunk) return
      thinkingBuffer += chunk
      scheduleFlush()
    },
    pushText: (chunk: string) => {
      if (!chunk) return
      textBuffer += chunk
      scheduleFlush()
    },
    setToolInput: (toolUseId: string, input: Record<string, unknown>) => {
      toolInputBuffer.set(toolUseId, input)
      scheduleToolInputFlush()
    },
    flushNow,
    dispose: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (toolInputTimer) {
        clearTimeout(toolInputTimer)
        toolInputTimer = null
      }
      thinkingBuffer = ''
      textBuffer = ''
      toolInputBuffer.clear()
    }
  }
}

/**
 * After an abort only terminal events are still applied: the run must still
 * persist its result, usage and final status even though the user stopped it.
 */
export function shouldHandleAgentEventAfterAbort(
  event: AgentEvent | TsRuntimeProjectedEvent
): boolean {
  switch (event.type) {
    case 'tool_call_result':
    case 'iteration_end':
    case 'message_end':
    case 'loop_end':
    case 'error':
      return true
    default:
      return false
  }
}

export function applyRequestRetryState(
  sessionId: string,
  event: Extract<AgentEvent, { type: 'request_retry' }>
): void {
  useAgentStore.getState().setSessionRequestRetryState(sessionId, {
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    delayMs: event.delayMs,
    ...(event.statusCode ? { statusCode: event.statusCode } : {}),
    reason: event.reason
  })
}

export function clearRequestRetryState(sessionId: string): void {
  useAgentStore.getState().setSessionRequestRetryState(sessionId, null)
}

export function createSubAgentEventBuffer(sessionId: string): {
  handleEvent: (event: SubAgentEvent) => void
  dispose: () => void
} {
  const deltaBuffers = new Map<
    string,
    {
      subAgentName: string
      text: string
      thinking: string
      timer?: ReturnType<typeof setTimeout>
    }
  >()

  const flushDelta = (toolUseId: string): void => {
    const entry = deltaBuffers.get(toolUseId)
    if (!entry) return
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    if (entry.thinking) {
      useAgentStore.getState().handleSubAgentEvent(
        {
          type: 'sub_agent_thinking_delta',
          subAgentName: entry.subAgentName,
          toolUseId,
          thinking: entry.thinking
        },
        sessionId
      )
      entry.thinking = ''
    }
    if (entry.text) {
      useAgentStore.getState().handleSubAgentEvent(
        {
          type: 'sub_agent_text_delta',
          subAgentName: entry.subAgentName,
          toolUseId,
          text: entry.text
        },
        sessionId
      )
      entry.text = ''
    }
  }

  const scheduleFlush = (toolUseId: string): void => {
    const entry = deltaBuffers.get(toolUseId)
    if (!entry || entry.timer) return
    entry.timer = setTimeout(() => {
      flushDelta(toolUseId)
    }, SUB_AGENT_TEXT_FLUSH_MS)
  }

  const flushAll = (): void => {
    for (const toolUseId of deltaBuffers.keys()) {
      flushDelta(toolUseId)
    }
  }

  const flushBeforeBoundary = (event: SubAgentEvent): void => {
    if ('toolUseId' in event) {
      flushDelta(event.toolUseId)
    }
  }

  return {
    handleEvent: (event) => {
      if (event.type === 'sub_agent_text_delta' || event.type === 'sub_agent_thinking_delta') {
        const entry = deltaBuffers.get(event.toolUseId) ?? {
          subAgentName: event.subAgentName,
          text: '',
          thinking: ''
        }
        entry.subAgentName = event.subAgentName
        if (event.type === 'sub_agent_text_delta') {
          entry.text += event.text
        } else {
          entry.thinking += event.thinking
        }
        deltaBuffers.set(event.toolUseId, entry)
        scheduleFlush(event.toolUseId)
        return
      }

      flushBeforeBoundary(event)
      useAgentStore.getState().handleSubAgentEvent(event, sessionId)
    },
    dispose: () => {
      flushAll()
      for (const entry of deltaBuffers.values()) {
        if (entry.timer) clearTimeout(entry.timer)
      }
      deltaBuffers.clear()
    }
  }
}

export interface LiveToolInputThrottleOptions {
  sessionId: string
  assistantMsgId: string
  /** Working folder used to fill a missing `cwd` on shell tool calls. */
  workingFolder?: string
  isForeground: () => boolean
}

export interface LiveToolInputThrottle {
  /** Compact, immediately usable summary of a fully streamed tool input. */
  summarizeImmediate: (
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>
  ) => Record<string, unknown>
  /** Record a partial argument delta and schedule a throttled live-card update. */
  scheduleUpdate: (
    toolCallId: string,
    partialInput: Record<string, unknown>,
    toolName?: string
  ) => void
  /** Drop queued updates once the tool call settles. */
  clearPending: (toolCallId: string) => void
  dispose: () => void
}

/**
 * Tool arguments stream as partial JSON, and re-rendering the card on every
 * delta is wasteful. This keeps one entry per tool call, sanitizes the input
 * once per signature, and pushes to the transcript plus the live agent card on
 * independent, foreground-aware intervals.
 */
export function createLiveToolInputThrottle(
  options: LiveToolInputThrottleOptions
): LiveToolInputThrottle {
  const { sessionId, assistantMsgId, workingFolder } = options
  const entries = new Map<string, LiveToolInputThrottleEntry>()

  const getEntry = (toolCallId: string): LiveToolInputThrottleEntry => {
    let entry = entries.get(toolCallId)
    if (!entry) {
      entry = { lastChatFlush: 0, lastAgentFlush: 0, lineCountCache: new Map() }
      entries.set(toolCallId, entry)
    }
    return entry
  }

  const clearPending = (toolCallId: string): void => {
    const entry = entries.get(toolCallId)
    if (!entry) return
    if (entry.chatTimer) {
      clearTimeout(entry.chatTimer)
      entry.chatTimer = undefined
    }
    if (entry.agentTimer) {
      clearTimeout(entry.agentTimer)
      entry.agentTimer = undefined
    }
    entry.pendingRaw = undefined
    entry.pendingSummary = undefined
    entry.pendingSignature = undefined
  }

  const maybeClearDelivered = (toolCallId: string, signature: string): void => {
    const entry = entries.get(toolCallId)
    if (!entry || entry.pendingSignature !== signature) return
    const needsAgentUpdate = options.isForeground()
    if (
      entry.lastChatSent === signature &&
      (!needsAgentUpdate || entry.lastAgentSent === signature)
    ) {
      entry.pendingRaw = undefined
      entry.pendingSummary = undefined
      entry.pendingSignature = undefined
    }
  }

  const withResolvedCommandCwd = (
    toolName: string,
    input: Record<string, unknown>
  ): Record<string, unknown> => {
    if (!COMMAND_TOOL_NAMES.has(toolName) || !workingFolder) return input
    const cwd = input.cwd
    if (typeof cwd === 'string' && cwd.trim()) return input
    return { ...input, cwd: workingFolder }
  }

  const getPending = (
    toolCallId: string,
    toolName: string
  ): { summary: Record<string, unknown>; signature: string } | null => {
    const entry = entries.get(toolCallId)
    if (!entry?.pendingRaw) return null

    if (!entry.pendingSummary || !entry.pendingSignature) {
      const startedAt = performance.now()
      const normalizedInput = withResolvedCommandCwd(toolName, entry.pendingRaw)
      const summary = summarizeToolInputForLiveCard(toolName, normalizedInput, {
        lineCountCache: entry.lineCountCache,
        cacheKeyPrefix: `${toolCallId}:${toolName || 'unknown'}`
      })
      const signature = liveToolInputSignature(summary)
      entry.pendingSummary = summary
      entry.pendingSignature = signature
      recordStreamingToolArgsDuration(performance.now() - startedAt, {
        toolCallId,
        toolName,
        inputKeys: Object.keys(normalizedInput).length,
        outputKeys: Object.keys(summary).length
      })
    }

    return { summary: entry.pendingSummary, signature: entry.pendingSignature }
  }

  const summarizeImmediate = (
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Record<string, unknown> => {
    const entry = getEntry(toolCallId)
    const startedAt = performance.now()
    const normalizedInput = withResolvedCommandCwd(toolName, input)
    const summary = summarizeToolInputForLiveCard(toolName, normalizedInput, {
      lineCountCache: entry.lineCountCache,
      cacheKeyPrefix: `${toolCallId}:${toolName || 'unknown'}`
    })
    recordStreamingToolArgsDuration(performance.now() - startedAt, {
      toolCallId,
      toolName,
      inputKeys: Object.keys(normalizedInput).length,
      outputKeys: Object.keys(summary).length,
      immediate: true
    })
    return summary
  }

  const getWidgetCode = (input?: Record<string, unknown>): string => {
    if (!input) return ''
    if (typeof input.widget_code === 'string') return input.widget_code
    if (typeof input.widget_code_preview === 'string') return input.widget_code_preview
    return ''
  }

  const mergeLiveWidgetInput = (
    previous: Record<string, unknown> | undefined,
    next: Record<string, unknown>
  ): Record<string, unknown> => {
    if (!previous) return next
    const previousCode = getWidgetCode(previous)
    const nextCode = getWidgetCode(next)
    if (!previousCode || nextCode.length >= previousCode.length) return next

    return {
      ...previous,
      ...next,
      ...(typeof previous.widget_code === 'string' ? { widget_code: previous.widget_code } : {}),
      ...(typeof previous.widget_code_preview === 'string'
        ? { widget_code_preview: previous.widget_code_preview }
        : {}),
      widget_code_chars:
        typeof next.widget_code_chars === 'number' && typeof previous.widget_code_chars === 'number'
          ? Math.max(previous.widget_code_chars, next.widget_code_chars)
          : (next.widget_code_chars ?? previous.widget_code_chars)
    }
  }

  const flushChat = (toolCallId: string, toolName: string): void => {
    const entry = entries.get(toolCallId)
    if (!entry?.pendingRaw) return
    const pending = getPending(toolCallId, toolName)
    if (!pending) return
    entry.lastChatFlush = Date.now()
    if (pending.signature !== entry.lastChatSent) {
      entry.lastChatSent = pending.signature
      updateRuntimeToolUseInput(sessionId, assistantMsgId, toolCallId, pending.summary)
    }
    maybeClearDelivered(toolCallId, pending.signature)
  }

  const flushAgent = (toolCallId: string, toolName: string): void => {
    if (!options.isForeground()) return
    const entry = entries.get(toolCallId)
    if (!entry?.pendingRaw) return
    const pending = getPending(toolCallId, toolName)
    if (!pending) return
    entry.lastAgentFlush = Date.now()
    if (pending.signature !== entry.lastAgentSent) {
      entry.lastAgentSent = pending.signature
      useAgentStore.getState().updateToolCall(toolCallId, { input: pending.summary }, sessionId)
    }
    maybeClearDelivered(toolCallId, pending.signature)
  }

  return {
    summarizeImmediate,
    clearPending,
    scheduleUpdate: (toolCallId, partialInput, toolName = '') => {
      const now = Date.now()
      const entry = getEntry(toolCallId)
      entry.pendingRaw =
        toolName === 'visualize_show_widget'
          ? mergeLiveWidgetInput(entry.pendingRaw, partialInput)
          : partialInput
      entry.pendingSummary = undefined
      entry.pendingSignature = undefined

      const chatDelay = Math.max(0, TOOL_INPUT_FLUSH_MS - (now - entry.lastChatFlush))
      if (chatDelay === 0) {
        if (entry.chatTimer) {
          clearTimeout(entry.chatTimer)
          entry.chatTimer = undefined
        }
        flushChat(toolCallId, toolName)
      } else if (!entry.chatTimer) {
        entry.chatTimer = setTimeout(() => {
          entry.chatTimer = undefined
          flushChat(toolCallId, toolName)
        }, chatDelay)
      }

      const agentInterval = options.isForeground()
        ? AGENT_TOOL_INPUT_FLUSH_MS
        : BACKGROUND_TOOL_INPUT_FLUSH_MS
      const agentDelay = Math.max(0, agentInterval - (now - entry.lastAgentFlush))
      if (agentDelay === 0) {
        if (entry.agentTimer) {
          clearTimeout(entry.agentTimer)
          entry.agentTimer = undefined
        }
        flushAgent(toolCallId, toolName)
      } else if (!entry.agentTimer) {
        entry.agentTimer = setTimeout(() => {
          entry.agentTimer = undefined
          flushAgent(toolCallId, toolName)
        }, agentDelay)
      }
    },
    dispose: () => {
      for (const entry of entries.values()) {
        if (entry.chatTimer) clearTimeout(entry.chatTimer)
        if (entry.agentTimer) clearTimeout(entry.agentTimer)
      }
      entries.clear()
    }
  }
}
