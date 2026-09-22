import type { ToolCallState } from '../lib/agent/types'
import type {
  MessageRequestModelMeta,
  RunLifecycleStatus,
  TokenUsage,
  UnifiedMessage
} from '../lib/api/types'

export type SubAgentReportStatus =
  | 'pending'
  | 'queued'
  | 'submitted'
  | 'retrying'
  | 'fallback'
  | 'missing'

export interface SubAgentState {
  name: string
  displayName?: string
  toolUseId: string
  sessionId?: string
  description: string
  prompt: string
  isRunning: boolean
  isQueued?: boolean
  success: boolean | null
  cancelled?: boolean
  errorMessage: string | null
  iteration: number
  toolCalls: ToolCallState[]
  streamingText: string
  transcript: UnifiedMessage[]
  currentAssistantMessageId: string | null
  report: string
  reportStatus: SubAgentReportStatus
  usage?: TokenUsage
  requestModel?: MessageRequestModelMeta
  startedAt: number
  completedAt: number | null
}

export interface AgentFileSnapshot {
  exists: boolean
  text?: string
  previewText?: string
  tailPreviewText?: string
  textOmitted?: boolean
  hash: string | null
  size: number
  lineCount?: number
}

export interface AgentRunFileChange {
  id: string
  runId: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
  filePath: string
  transport: 'local' | 'ssh'
  connectionId?: string
  op: 'create' | 'modify'
  status: 'open' | 'reverted'
  before: AgentFileSnapshot
  after: AgentFileSnapshot
  createdAt: number
  revertedAt?: number
}

export interface AgentRunChangeSet {
  runId: string
  sessionId?: string
  assistantMessageId: string
  status: 'open' | 'reverted'
  changes: AgentRunFileChange[]
  createdAt: number
  updatedAt: number
}

export type SessionExecutionStatus = RunLifecycleStatus | 'running' | 'retrying'
