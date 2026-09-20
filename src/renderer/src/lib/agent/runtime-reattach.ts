import type { ToolCallState } from './types'
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
  mergeRuntimeMessageUsage
} from './session-runtime-router'
import type { FinalOutcomeStatus } from '../api/types'

import {
  getTsRuntimeRunSnapshot,
  listTsRuntimeRuns,
  respondTsRuntimeInteraction
} from '../ipc/ts-runtime-bridge'
import { normalizeRuntimeApprovalRequest } from '../ipc/runtime-approval-protocol'
import { useSettingsStore } from '../../stores/settings-store'
import { ensureWindowWorkspaceRegistered } from '../window-workspace-registration'
import {
  createTsRuntimeProjectionState,
  isTerminalTsRuntimeStatus,
  projectTsRuntimeEvents,
  type TsRuntimeProjectedEvent
} from '../ipc/ts-runtime-projection'

function finishRun(_runId: string, sessionId: string, status: FinalOutcomeStatus): void {
  useChatStore.getState().setStreamingMessageId(sessionId, null)
  useRuntimeProjectionStore.getState().finish(sessionId, status)
  useAgentStore.getState().setSessionStatus(sessionId, status)
}

// TS runtime events are persisted by the scheduler, so a new window can replay
// them without asking the model to run again. Keep this projection beside the
// reattach path; both write through the same session-runtime router.
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
  const request = normalizeRuntimeApprovalRequest({
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
