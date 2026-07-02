import type { ToolCallState } from '@renderer/lib/agent/types'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import type { SubAgentState } from '@renderer/stores/agent-store'
import type { ActiveTeam } from '@renderer/stores/team-store'
import type { TeamMember, TeamMessage, TeamTask } from '@renderer/lib/agent/teams/types'

export type OrchestrationRunKind = 'single-agent' | 'team'
export type OrchestrationRunStatus = 'running' | 'completed' | 'failed'
export type OrchestrationStageStatus = 'completed' | 'active' | 'pending'

export interface OrchestrationStage {
  id: string
  label: string
  status: OrchestrationStageStatus
}

export interface OrchestrationMember {
  id: string
  toolUseId?: string
  name: string
  role?: string
  agentName?: string
  model?: string
  status: 'working' | 'idle' | 'waiting' | 'stopped' | 'completed' | 'failed'
  isRunning: boolean
  isSelected?: boolean
  iteration: number
  startedAt: number
  completedAt: number | null
  currentTaskId?: string | null
  currentTaskLabel?: string | null
  description?: string
  prompt?: string
  summary: string
  latestAction: string
  progress: number
  usageTokens?: number
  toolCallCount: number
  transcript: UnifiedMessage[]
  toolCalls: ToolCallState[]
  report?: string
  errorMessage?: string | null
}

export interface OrchestrationSnapshot {
  summary: string
  latestAction: string
  members: Array<{
    id: string
    name: string
    status: OrchestrationMember['status']
    summary: string
    latestAction: string
    progress: number
    toolCallCount: number
    iteration: number
  }>
}

export interface OrchestrationRun {
  id: string
  sessionId?: string
  sourceMessageId: string
  kind: OrchestrationRunKind
  title: string
  status: OrchestrationRunStatus
  startedAt: number
  completedAt: number | null
  stageIndex: number
  stageCount: number
  stages: OrchestrationStage[]
  summary: string
  latestAction: string
  members: OrchestrationMember[]
  tasks: TeamTask[]
  messages: TeamMessage[]
  selectedMemberId?: string | null
  sourceToolUseIds: string[]
  historySnapshot: OrchestrationSnapshot
  team?: ActiveTeam | null
}

export interface BuildRunsInput {
  sessionId?: string | null
  messages: UnifiedMessage[]
  activeSubAgents: Record<string, SubAgentState>
  completedSubAgents: Record<string, SubAgentState>
  subAgentHistory: SubAgentState[]
  activeTeam: ActiveTeam | null
  teamHistory: ActiveTeam[]
}

export interface OrchestrationMessageBinding {
  primaryRun: OrchestrationRun | null
  hiddenToolUseIds: Set<string>
}

export interface OrchestrationDerivedState {
  runs: OrchestrationRun[]
  byId: Map<string, OrchestrationRun>
  byMessageId: Map<string, OrchestrationMessageBinding>
}

export interface TeamCandidate {
  team: ActiveTeam
  runId: string
  sourceMessageId: string
}

export interface MemberTaskLookup {
  byId: Map<string, TeamTask>
  byOwner: Map<string, TeamTask>
}

export type OrchestrationSourceMember =
  | {
      kind: 'subagent'
      state: SubAgentState
    }
  | {
      kind: 'team-member'
      member: TeamMember
      team: ActiveTeam
    }
