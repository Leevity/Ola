import type { AgentStreamEvent, ToolCallStateWire } from '../../../../shared/agent-stream-protocol'
import type { ToolCallState } from './types'
import type { ToolUseBlock } from '../api/types'
import { agentBridge } from '../ipc/agent-bridge'
import { agentStream } from '../ipc/agent-stream-receiver'
import { useAgentStore } from '../../stores/agent-store'
import { useChatStore } from '../../stores/chat-store'
import { useRuntimeProjectionStore } from '../../stores/runtime-projection-store'
import {
  addRuntimeMessage,
  appendRuntimeContentBlock,
  appendRuntimeTextDelta,
  appendRuntimeThinkingDelta,
  appendRuntimeToolUse,
  completeRuntimeThinking,
  mergeRuntimeMessageUsage,
  updateRuntimeMessage,
  setRuntimeThinkingEncryptedContent,
  updateRuntimeToolUseInput
} from './session-runtime-router'
import { sessionSidecarRunIds } from './session-run-registry'
import {
  hasCompleteAgentRunJournal,
  resolveAgentRunAttachSequence
} from '../../../../shared/agent-runtime-recovery'

const attachedRuns = new Map<string, () => void>()

function toToolCallState(toolCall: ToolCallStateWire, sessionId: string): ToolCallState {
  return { ...(toolCall as unknown as ToolCallState), sessionId }
}

function finishRun(runId: string, sessionId: string, status: 'completed' | null): void {
  attachedRuns.get(runId)?.()
  attachedRuns.delete(runId)
  if (sessionSidecarRunIds.get(sessionId) === runId) sessionSidecarRunIds.delete(sessionId)
  useChatStore.getState().setStreamingMessageId(sessionId, null)
  useRuntimeProjectionStore
    .getState()
    .finish(sessionId, status === 'completed' ? 'completed' : 'failed')
  useAgentStore.getState().setSessionStatus(sessionId, status)
}

function applyEvent(
  runId: string,
  sessionId: string,
  messageId: string,
  event: AgentStreamEvent
): void {
  switch (event.type) {
    case 'thinking_delta':
      appendRuntimeThinkingDelta(sessionId, messageId, event.thinking)
      break
    case 'thinking_encrypted':
      setRuntimeThinkingEncryptedContent(sessionId, messageId, event.content, event.provider)
      break
    case 'text_delta':
      completeRuntimeThinking(sessionId, messageId)
      appendRuntimeTextDelta(sessionId, messageId, event.text)
      break
    case 'tool_use_generated':
      appendRuntimeToolUse(sessionId, messageId, {
        type: 'tool_use',
        id: event.toolUseBlock.id,
        name: event.toolUseBlock.name,
        input: event.toolUseBlock.input,
        ...(event.toolUseBlock.extraContent
          ? { extraContent: event.toolUseBlock.extraContent as ToolUseBlock['extraContent'] }
          : {})
      })
      break
    case 'tool_use_args_delta':
      updateRuntimeToolUseInput(sessionId, messageId, event.toolCallId, event.partialInput)
      break
    case 'tool_call_start':
    case 'tool_call_approval_needed':
      useAgentStore.getState().addToolCall(toToolCallState(event.toolCall, sessionId), sessionId)
      break
    case 'tool_call_update':
    case 'tool_call_result':
      useAgentStore
        .getState()
        .updateToolCall(event.toolCall.id, toToolCallState(event.toolCall, sessionId), sessionId)
      break
    case 'message_end':
      if (event.usage) mergeRuntimeMessageUsage(sessionId, messageId, event.usage)
      break
    case 'image_generated':
      appendRuntimeContentBlock(sessionId, messageId, event.imageBlock)
      break
    case 'error':
      appendRuntimeContentBlock(sessionId, messageId, {
        type: 'agent_error',
        code: 'runtime_error',
        message: event.message,
        ...(event.errorType ? { errorType: event.errorType } : {}),
        ...(event.details ? { details: event.details } : {})
      })
      finishRun(runId, sessionId, null)
      break
    case 'loop_end':
      finishRun(runId, sessionId, 'completed')
      break
  }
}

async function attachRun(run: {
  runId: string
  sessionId: string
  assistantMessageId: string
  firstSeq: number
  lastSeq: number
}): Promise<void> {
  if (attachedRuns.has(run.runId)) return
  await useChatStore
    .getState()
    .loadRecentSessionMessages(run.sessionId, true)
    .catch(() => {})

  const messages = useChatStore.getState().getSessionMessages(run.sessionId)
  if (!messages.some((message) => message.id === run.assistantMessageId)) {
    addRuntimeMessage(run.sessionId, {
      id: run.assistantMessageId,
      role: 'assistant',
      content: [],
      createdAt: Date.now()
    })
  } else if (hasCompleteAgentRunJournal(run.firstSeq)) {
    updateRuntimeMessage(run.sessionId, run.assistantMessageId, {
      content: [],
      usage: undefined
    })
  }
  sessionSidecarRunIds.set(run.sessionId, run.runId)
  useRuntimeProjectionStore.getState().begin(run.sessionId, run.runId, run.assistantMessageId)
  useChatStore.getState().setStreamingMessageId(run.sessionId, run.assistantMessageId)
  useAgentStore.getState().setSessionStatus(run.sessionId, 'running')

  const unsubscribe = agentStream.subscribe(run.runId, (event) => {
    applyEvent(run.runId, run.sessionId, run.assistantMessageId, event)
  })
  attachedRuns.set(run.runId, unsubscribe)

  const response = await agentBridge.attachAgentRun(
    run.runId,
    resolveAgentRunAttachSequence({
      firstSeq: run.firstSeq,
      lastSeq: run.lastSeq,
      receiverLastSeq: agentStream.getLastSeq(run.runId)
    })
  )
  if (!response.attached) {
    finishRun(run.runId, run.sessionId, null)
    return
  }
  agentStream.ingest(response.frames)
}

export async function reattachActiveAgentRuns(): Promise<void> {
  const state = await agentBridge.getAgentRuntimeState()
  await Promise.all(state.runs.map((run) => attachRun(run)))
}
