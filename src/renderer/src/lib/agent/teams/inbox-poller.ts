import type { ToolCallState } from '../types'
import type {
  TeamRuntimePermissionUpdatePayload,
  TeamRuntimePlanApprovalRequestPayload,
  TeamRuntimePlanApprovalResponsePayload
} from '../../../../../shared/team-runtime-types'
import { useAgentStore } from '../../../stores/agent-store'
import { useTeamStore } from '../../../stores/team-store'
import type { TeamMessage } from './types'
import {
  appendTeamRuntimeMessage,
  consumeTeamRuntimeMessages,
  getTeamRuntimeSnapshot
} from './runtime-client'

let pollerTimer: ReturnType<typeof setInterval> | null = null
let lastLeadMessageTimestamp = 0
let lastTeamKey = ''
let pollInFlight = false
const seenMessageIds = new Set<string>()
const approvalRequestToToolCallId = new Map<string, string>()

function parseToolCall(content: string): ToolCallState | null {
  try {
    const parsed = JSON.parse(content) as ToolCallState
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string') return null
    if (!parsed.input || typeof parsed.input !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function parsePermissionUpdate(content: string): TeamRuntimePermissionUpdatePayload | null {
  try {
    const parsed = JSON.parse(content) as TeamRuntimePermissionUpdatePayload
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function parsePlanApprovalRequest(content: string): TeamRuntimePlanApprovalRequestPayload | null {
  try {
    const parsed = JSON.parse(content) as TeamRuntimePlanApprovalRequestPayload
    if (!parsed || typeof parsed.requestId !== 'string' || typeof parsed.plan !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function registerPendingApproval(requestId: string, toolCallId: string, replyTo: string): void {
  approvalRequestToToolCallId.set(requestId, toolCallId)
  useAgentStore.getState().registerApprovalSource(toolCallId, { requestId, replyTo })
}

export async function sendApprovalResponse(params: {
  requestId: string
  approved: boolean
  to: string
  summary?: string
}): Promise<void> {
  const team = useTeamStore.getState().activeTeam
  if (!team) return

  approvalRequestToToolCallId.delete(params.requestId)

  await appendTeamRuntimeMessage({
    teamName: team.name,
    message: {
      id: `perm-res-${params.requestId}-${Date.now()}`,
      from: 'lead',
      to: params.to,
      type: 'permission_response',
      content: JSON.stringify({ approved: params.approved, requestId: params.requestId }),
      summary: params.summary,
      timestamp: Date.now()
    }
  })
}

export async function sendPlanApprovalResponse(params: {
  requestId: string
  approved: boolean
  to: string
  feedback?: string
}): Promise<void> {
  const team = useTeamStore.getState().activeTeam
  if (!team) return

  const payload: TeamRuntimePlanApprovalResponsePayload = {
    requestId: params.requestId,
    approved: params.approved,
    ...(params.feedback ? { feedback: params.feedback } : {})
  }

  await appendTeamRuntimeMessage({
    teamName: team.name,
    message: {
      id: `plan-res-${params.requestId}-${Date.now()}`,
      from: 'lead',
      to: params.to,
      type: 'plan_approval_response',
      content: JSON.stringify(payload),
      summary: params.approved ? 'Leader approved plan' : 'Leader rejected plan',
      timestamp: Date.now()
    }
  })
}

async function handleLeadMessage(message: TeamMessage): Promise<void> {
  if (seenMessageIds.has(message.id)) return
  seenMessageIds.add(message.id)
  lastLeadMessageTimestamp = Math.max(lastLeadMessageTimestamp, message.timestamp)

  if (message.type === 'permission_request') {
    const toolCall = parseToolCall(message.content)
    if (!toolCall) return

    useAgentStore.getState().addToolCall({
      ...toolCall,
      status: 'pending_approval',
      requiresApproval: true
    })

    registerPendingApproval(message.id, toolCall.id, message.from)
    return
  }

  if (message.type === 'team_permission_update' || message.type === 'mode_set_request') {
    const payload = parsePermissionUpdate(message.content)
    if (!payload) return

    useTeamStore.getState().updateTeamMeta({
      ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
      ...(payload.teamAllowedPaths ? { teamAllowedPaths: payload.teamAllowedPaths } : {})
    })
    return
  }

  if (message.type === 'plan_approval_request') {
    const payload = parsePlanApprovalRequest(message.content)
    if (!payload) return

    const syntheticToolCall: ToolCallState = {
      id: `plan-${payload.requestId}`,
      name: 'PlanApproval',
      input: {
        task_id: payload.taskId ?? null,
        plan: payload.plan,
        from: message.from
      },
      status: 'pending_approval',
      requiresApproval: true
    }

    useAgentStore.getState().addToolCall(syntheticToolCall)
    useAgentStore.getState().registerApprovalSource(syntheticToolCall.id, {
      requestId: payload.requestId,
      replyTo: message.from,
      source: 'teammate-plan'
    })
  }
}

export function startTeamInboxPoller(): void {
  if (pollerTimer) return

  pollerTimer = setInterval(() => {
    const team = useTeamStore.getState().activeTeam
    if (!team?.name) return
    const teamKey = `${team.name}\0${team.sessionId ?? ''}`
    if (teamKey !== lastTeamKey) {
      lastTeamKey = teamKey
      lastLeadMessageTimestamp = 0
      seenMessageIds.clear()
    }
    if (pollInFlight) return
    pollInFlight = true

    void (async () => {
      try {
        const [snapshot, messages] = await Promise.all([
          getTeamRuntimeSnapshot({ teamName: team.name, limit: 20 }),
          consumeTeamRuntimeMessages({
            teamName: team.name,
            afterTimestamp: lastLeadMessageTimestamp,
            recipient: 'lead',
            includeBroadcast: true,
            limit: 20
          })
        ])
        const currentTeam = useTeamStore.getState().activeTeam
        if (`${currentTeam?.name ?? ''}\0${currentTeam?.sessionId ?? ''}` !== teamKey) return
        if (snapshot) {
          useTeamStore.getState().syncRuntimeSnapshot(snapshot, team.sessionId)
        }
        for (const message of messages) {
          await handleLeadMessage({
            id: message.id,
            from: message.from,
            to: message.to,
            type: message.type,
            content: message.content,
            summary: message.summary,
            timestamp: message.timestamp
          })
        }
      } catch (error) {
        console.error('[TeamRuntime] Runtime snapshot poll failed:', error)
      } finally {
        pollInFlight = false
      }
    })()
  }, 1000)
}

export function stopTeamInboxPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer)
    pollerTimer = null
  }
  pollInFlight = false
  lastTeamKey = ''
  lastLeadMessageTimestamp = 0
  seenMessageIds.clear()
  approvalRequestToToolCallId.clear()
}
