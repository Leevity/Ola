import type { RequestRetryState, ToolCallState } from '../lib/agent/types'
import type { AgentRunChangeSet, SessionExecutionStatus, SubAgentState } from './agent-types'

export interface AgentSessionState {
  liveSessionId: string | null
  runningSessions: Record<string, SessionExecutionStatus>
  sessionRequestRetryState: Record<string, RequestRetryState>
  sessionSubAgentSummaries: Record<string, SubAgentState[]>
  sessionToolCallsCache: Record<string, { pending: ToolCallState[]; executed: ToolCallState[] }>
}

export function selectSessionExecutionStatus(
  state: Pick<AgentSessionState, 'runningSessions'>,
  sessionId: string | null | undefined
): SessionExecutionStatus | null {
  return sessionId ? state.runningSessions[sessionId] ?? null : null
}

export function selectSessionRetryState(
  state: Pick<AgentSessionState, 'sessionRequestRetryState'>,
  sessionId: string | null | undefined
): RequestRetryState | null {
  return sessionId ? state.sessionRequestRetryState[sessionId] ?? null : null
}

export function selectSessionToolCalls(
  state: Pick<AgentSessionState, 'liveSessionId' | 'sessionToolCallsCache'> & {
    pendingToolCalls: ToolCallState[]
    executedToolCalls: ToolCallState[]
  },
  sessionId: string | null | undefined
): { pending: ToolCallState[]; executed: ToolCallState[] } {
  if (!sessionId || sessionId === state.liveSessionId) {
    return { pending: state.pendingToolCalls, executed: state.executedToolCalls }
  }
  return state.sessionToolCallsCache[sessionId] ?? { pending: [], executed: [] }
}

export function selectSessionSubAgents(
  state: Pick<AgentSessionState, 'sessionSubAgentSummaries'>,
  sessionId: string | null | undefined
): SubAgentState[] {
  return sessionId ? state.sessionSubAgentSummaries[sessionId] ?? [] : []
}

export function selectRunChangeSet(
  state: { runChangesByRunId: Record<string, AgentRunChangeSet> },
  runId: string | null | undefined
): AgentRunChangeSet | null {
  return runId ? state.runChangesByRunId[runId] ?? null : null
}
