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
import type { FinalOutcomeStatus } from '../api/types'

import {
  getTsRuntimeRunSnapshot,
  listTsRuntimeRuns,
  respondTsRuntimeInteraction
} from '../ipc/ts-runtime-bridge'
import { normalizeSidecarApprovalRequest } from '../ipc/sidecar-protocol'
import { useSettingsStore } from '../../stores/settings-store'
import { ensureWindowWorkspaceRegistered } from '../window-workspace-registration'
import {
  createTsRuntimeProjectionState,
  isTerminalTsRuntimeStatus,
  projectTsRuntimeEvents,
  type TsRuntimeProjectedEvent
} from '../ipc/ts-runtime-projection'

const attachedRuns = new Map<string, () => void>()

function toToolCallState(toolCall: ToolCallStateWire, sessionId: string): ToolCallState {
  return { ...(toolCall as unknown as ToolCallState), sessionId }
}

function finishRun(runId: string, sessionId: string, status: FinalOutcomeStatus): void {
  attachedRuns.get(runId)?.()
  attachedRuns.delete(runId)
  if (sessionSidecarRunIds.get(sessionId) === runId) sessionSidecarRunIds.delete(sessionId)
  useChatStore.getState().setStreamingMessageId(sessionId, null)
  useRuntimeProjectionStore.getState().finish(sessionId, status)
  useAgentStore.getState().setSessionStatus(sessionId, status)
}

function terminalStatusForReason(
  reason: Extract<AgentStreamEvent, { type: 'loop_end' }>['reason']
): FinalOutcomeStatus {
  if (reason === 'aborted') return 'canceled'
  if (reason === 'max_iterations') return 'partial'
  if (reason === 'error') return 'failed'
  return 'completed'
}

function applyEvent(
  runId: string,
  sessionId: string,
  messageId: string,
  event: AgentStreamEvent
): void {
  switch (event.type) {
    case 'thinking_delta':
      useRuntimeProjectionStore.getState().setPhase(sessionId, 'thinking')
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
      useRuntimeProjectionStore.getState().setPhase(sessionId, 'executing')
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
      useRuntimeProjectionStore.getState().setPhase(sessionId, 'executing')
      useAgentStore.getState().addToolCall(toToolCallState(event.toolCall, sessionId), sessionId)
      break
    case 'tool_call_approval_needed':
      useRuntimeProjectionStore.getState().setPhase(sessionId, 'waiting_user')
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
      finishRun(runId, sessionId, 'failed')
      break
    case 'loop_end':
      finishRun(runId, sessionId, terminalStatusForReason(event.reason))
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
    finishRun(run.runId, run.sessionId, 'failed')
    return
  }
  agentStream.ingest(response.frames)
}

export async function reattachActiveAgentRuns(): Promise<void> {
  const state = await agentBridge.getAgentRuntimeState()
  await Promise.all(state.runs.map((run) => attachRun(run)))
}

// TS runtime events are persisted by the scheduler, so a new window can replay
// them without asking the model to run again. Keep this projection beside the
// sidecar reattach path; both write through the same session-runtime router.
const attachedTsRunIds = new Set<string>()

function applyTsReattachEvent(
  runId: string,
  sessionId: string,
  messageId: string,
  event: TsRuntimeProjectedEvent
): void {
  if (event.type === 'thinking_delta' && typeof event.thinking === 'string') {
    useRuntimeProjectionStore.getState().setPhase(sessionId, 'thinking')
    appendRuntimeThinkingDelta(sessionId, messageId, event.thinking)
  } else if (event.type === 'text_delta' && typeof event.text === 'string') {
    completeRuntimeThinking(sessionId, messageId)
    appendRuntimeTextDelta(sessionId, messageId, event.text)
  } else if (event.type === 'tool_use_generated') {
    useRuntimeProjectionStore.getState().setPhase(sessionId, 'executing')
    appendRuntimeToolUse(sessionId, messageId, { type: 'tool_use', ...event.toolUseBlock })
    useAgentStore.getState().addToolCall(
      {
        id: event.toolUseBlock.id,
        name: event.toolUseBlock.name,
        input: event.toolUseBlock.input,
        status: 'running',
        requiresApproval: false,
        startedAt: Date.now()
      },
      sessionId
    )
  } else if (event.type === 'tool_call_result') {
    useAgentStore
      .getState()
      .updateToolCall(
        event.toolCall.id,
        { ...event.toolCall, sessionId } as ToolCallState,
        sessionId
      )
  } else if (event.type === 'message_end' && event.usage) {
    mergeRuntimeMessageUsage(sessionId, messageId, event.usage)
  } else if (event.type === 'error') {
    const error = event.error
    appendRuntimeContentBlock(sessionId, messageId, {
      type: 'agent_error',
      code: 'runtime_error',
      message: error?.message ?? 'TS runtime execution failed.',
      ...(error?.type ? { errorType: error.type } : {})
    })
    finishRun(runId, sessionId, error?.type === 'RUN_CANCELLED' ? 'canceled' : 'failed')
  } else if (event.type === 'loop_end') {
    finishRun(runId, sessionId, 'completed')
  }
}

async function resolveTsReattachInteraction(
  interaction: import('../../../../shared/runtime/contracts').PendingRuntimeInteraction,
  sessionId: string
): Promise<void> {
  // Interactions survive the renderer that created the run. Recreate the same
  // approval request here so reopening a window cannot leave a persisted run
  // waiting forever for a response that only the previous window could send.
  if (interaction.kind !== 'tool-approval') {
    await respondTsRuntimeInteraction({
      workspaceId: interaction.workspaceId,
      runId: interaction.runId,
      interactionId: interaction.interactionId,
      response: {
        approved: false,
        reason: `Unsupported TS runtime interaction: ${interaction.kind}`
      }
    })
    return
  }
  const request = normalizeSidecarApprovalRequest({
    runId: interaction.runId,
    sessionId,
    toolCall: interaction.payload
  })
  if (!request) {
    await respondTsRuntimeInteraction({
      workspaceId: interaction.workspaceId,
      runId: interaction.runId,
      interactionId: interaction.interactionId,
      response: { approved: false, reason: 'Invalid TS runtime tool approval request' }
    })
    return
  }
  useRuntimeProjectionStore.getState().setPhase(sessionId, 'waiting_user')
  const agentStore = useAgentStore.getState()
  const autoApprove =
    useSettingsStore.getState().autoApprove ||
    agentStore.approvedToolNames.includes(request.toolCall.name)
  if (!autoApprove) agentStore.addToolCall(request.toolCall, sessionId)
  const approved = autoApprove ? true : await agentStore.requestApproval(request.toolCall.id)
  if (approved) agentStore.addApprovedTool(request.toolCall.name)
  await respondTsRuntimeInteraction({
    workspaceId: interaction.workspaceId,
    runId: interaction.runId,
    interactionId: interaction.interactionId,
    response: approved ? { approved: true } : { approved: false, reason: 'User denied permission' }
  })
}

function terminalTsOutcome(
  status: import('../../../../shared/runtime/contracts').RunStatus
): FinalOutcomeStatus {
  if (status === 'cancelled') return 'canceled'
  return status === 'completed' ? 'completed' : 'failed'
}

async function attachTsRuntimeRun(run: {
  runId: string
  sessionId: string
  assistantMessageId: string
  workspaceId: string
}): Promise<void> {
  if (attachedTsRunIds.has(run.runId)) return
  attachedTsRunIds.add(run.runId)
  await useChatStore
    .getState()
    .loadRecentSessionMessages(run.sessionId, true)
    .catch(() => {})
  if (
    !useChatStore
      .getState()
      .getSessionMessages(run.sessionId)
      .some((m) => m.id === run.assistantMessageId)
  ) {
    addRuntimeMessage(run.sessionId, {
      id: run.assistantMessageId,
      role: 'assistant',
      content: [],
      createdAt: Date.now()
    })
  }
  useRuntimeProjectionStore.getState().begin(run.sessionId, run.runId, run.assistantMessageId)
  useChatStore.getState().setStreamingMessageId(run.sessionId, run.assistantMessageId)
  useAgentStore.getState().setSessionStatus(run.sessionId, 'running')
  const projection = createTsRuntimeProjectionState()
  let afterSeq = 0
  const resolvedInteractions = new Set<string>()
  for (;;) {
    const snapshot = await getTsRuntimeRunSnapshot({
      workspaceId: run.workspaceId,
      runId: run.runId,
      afterSeq
    })
    if (!snapshot) break
    for (const item of snapshot.events) {
      afterSeq = Math.max(afterSeq, item.seq)
      for (const event of projectTsRuntimeEvents([item], projection))
        applyTsReattachEvent(run.runId, run.sessionId, run.assistantMessageId, event)
    }
    for (const interaction of snapshot.pendingInteractions) {
      const key = `${interaction.runId}:${interaction.interactionId}`
      if (resolvedInteractions.has(key)) continue
      resolvedInteractions.add(key)
      await resolveTsReattachInteraction(interaction, run.sessionId)
    }
    if (isTerminalTsRuntimeStatus(snapshot.run.status)) {
      if (snapshot.run.status !== 'completed')
        finishRun(run.runId, run.sessionId, terminalTsOutcome(snapshot.run.status))
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  attachedTsRunIds.delete(run.runId)
}

/** Replays active TS runs owned by the currently visible workspace without resubmitting them. */
export async function reattachActiveTsRuntimeRuns(workspaceId: string): Promise<void> {
  await ensureWindowWorkspaceRegistered(workspaceId)
  const runs = await listTsRuntimeRuns(workspaceId)
  await Promise.all(
    runs
      .filter(
        (run) =>
          !isTerminalTsRuntimeStatus(run.status) &&
          typeof run.assistantMessageId === 'string' &&
          run.assistantMessageId.trim()
      )
      .map((run) =>
        attachTsRuntimeRun({
          runId: run.runId,
          sessionId: run.sessionId,
          assistantMessageId: run.assistantMessageId!,
          workspaceId: run.workspaceId
        })
      )
  )
}
