import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { isSessionForeground } from '@renderer/lib/agent/session-runtime-router'
import type { ToolCallState } from '@renderer/lib/agent/types'
import { respondTsRuntimeInteraction } from '@renderer/lib/ipc/ts-runtime-bridge'
import type { TsRuntimeInteractionEvent } from '@renderer/lib/ipc/ts-runtime-projection'
import { normalizeRuntimeApprovalRequest } from '@renderer/lib/ipc/runtime-approval-protocol'
import { resolveTsRuntimeBrowserInteraction } from '@renderer/lib/ipc/browser-runtime-interaction'
import { handleNativeAskUserRequest } from '@renderer/lib/tools/ask-user-tool'
import { requestRemoteAutoApproval } from '@renderer/lib/remote/remote-auto-approval'

export interface RuntimeInteractionContext {
  sessionId: string
  /**
   * Called before an approval dialog can appear. The caller uses this to project
   * the run into `waiting_user` and mark the run as having used tools.
   */
  onApprovalPending?: (toolCall: ToolCallState) => void
}

function interactionPayload(event: TsRuntimeInteractionEvent): Record<string, unknown> {
  const payload = event.interaction.payload
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

/**
 * Answers a runtime `AskUserQuestion`. The runtime persists the interaction
 * before emitting it, so the response is scoped by run id and interaction id.
 */
export async function resolveTsRuntimeQuestion(
  event: TsRuntimeInteractionEvent,
  sessionId: string
): Promise<void> {
  const resolved = await handleNativeAskUserRequest({
    questions: interactionPayload(event).questions,
    toolUseId: event.interaction.interactionId,
    sessionId
  })
  await respondTsRuntimeInteraction({
    workspaceId: event.interaction.workspaceId,
    runId: event.interaction.runId,
    interactionId: event.interaction.interactionId,
    response: resolved
  })
}

/**
 * Resolves one runtime interaction. Every branch responds to the runtime —
 * an unanswered interaction leaves the run stranded in `waiting_interaction`,
 * so malformed or unsupported kinds are denied rather than ignored.
 *
 * Approval decision order: settings auto-approve / an already-approved tool name
 * short-circuit the dialog; otherwise the user decides through the normal
 * approval UI and an approve also remembers the tool for the rest of the session.
 */
export async function resolveRuntimeInteraction(
  event: TsRuntimeInteractionEvent,
  context: RuntimeInteractionContext
): Promise<void> {
  const { sessionId } = context

  if (event.interaction.kind === 'question') {
    await resolveTsRuntimeQuestion(event, sessionId)
    return
  }
  if (event.interaction.kind === 'browser-tool') {
    await resolveTsRuntimeBrowserInteraction(event.interaction, sessionId)
    return
  }
  if (event.interaction.kind !== 'tool-approval') {
    await respondTsRuntimeInteraction({
      workspaceId: event.interaction.workspaceId,
      runId: event.interaction.runId,
      interactionId: event.interaction.interactionId,
      response: {
        approved: false,
        reason: `Unsupported TS runtime interaction: ${event.interaction.kind}`
      }
    })
    return
  }

  const request = normalizeRuntimeApprovalRequest({
    runId: event.interaction.runId,
    sessionId,
    toolCall: event.interaction.payload
  })
  if (!request) {
    await respondTsRuntimeInteraction({
      workspaceId: event.interaction.workspaceId,
      runId: event.interaction.runId,
      interactionId: event.interaction.interactionId,
      response: { approved: false, reason: 'Invalid TS runtime tool approval request' }
    })
    return
  }

  // A live unattended session may answer this approval on behalf of the absent
  // user. The main process refuses unless the run was submitted while that
  // session was already open, so a local run in the same window is never
  // auto-approved. Nothing is added to the local allowlist: when the session
  // ends the next approval asks a human again.
  if (await requestRemoteAutoApproval(event.interaction.runId, request.toolCall.name)) {
    await respondTsRuntimeInteraction({
      workspaceId: event.interaction.workspaceId,
      runId: event.interaction.runId,
      interactionId: event.interaction.interactionId,
      response: { approved: true }
    })
    return
  }

  context.onApprovalPending?.(request.toolCall)
  const agentStore = useAgentStore.getState()
  const autoApprove =
    useSettingsStore.getState().autoApprove ||
    agentStore.approvedToolNames.includes(request.toolCall.name)
  if (!autoApprove && isSessionForeground(sessionId)) {
    agentStore.addToolCall(request.toolCall, sessionId)
  }
  const approved = autoApprove ? true : await agentStore.requestApproval(request.toolCall.id)
  if (approved) agentStore.addApprovedTool(request.toolCall.name)

  await respondTsRuntimeInteraction({
    workspaceId: event.interaction.workspaceId,
    runId: event.interaction.runId,
    interactionId: event.interaction.interactionId,
    response: approved ? { approved: true } : { approved: false, reason: 'User denied permission' }
  })
}
