export type MemoryAutomationScope = 'main' | 'channel' | 'shared' | 'cron' | 'sub_agent'

export type MemoryRootScope = 'global' | 'project'

export type MemoryRootTransport = 'local' | 'ssh'

export type MemoryScopeMode = 'hybrid'

export type MemoryAutomationCandidateKind =
  | 'user_preference'
  | 'workflow_habit'
  | 'project_decision'
  | 'recurring_error'
  | 'follow_up'
  | 'daily_context'

export type MemoryAutomationTarget =
  | 'global_user'
  | 'global_memory'
  | 'project_user'
  | 'project_memory'
  | 'global_daily'
  | 'project_daily'
  | 'summary_cache'

export type MemoryAutomationStatus = 'written' | 'filtered' | 'skipped' | 'error' | 'undone'

export type MemoryJobKind = 'stage1' | 'phase2' | 'daily_rollup'

export type MemoryJobStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'succeeded_no_output'
  | 'skipped'
  | 'failed'

export type MemoryAutomationFilterReason =
  | 'disabled'
  | 'unsupported_scope'
  | 'missing_provider'
  | 'unsupported_provider'
  | 'invalid_json'
  | 'no_candidates'
  | 'low_confidence'
  | 'secret'
  | 'private_identity'
  | 'temporary_chatter'
  | 'duplicate'
  | 'missing_target'
  | 'unsafe_target'
  | 'write_error'
  | 'rollup_already_processed'
  | 'summary_not_needed'
  | 'undo_conflict'

export interface MemoryAutomationEntry {
  id: string
  scope: MemoryAutomationScope
  rootScope?: MemoryRootScope | null
  memoryRootId?: string | null
  jobId?: string | null
  projectId?: string | null
  target: MemoryAutomationTarget
  kind: MemoryAutomationCandidateKind
  content: string
  confidence: number
  sourceSessionId?: string | null
  targetPath?: string | null
  status: MemoryAutomationStatus
  filterReason?: MemoryAutomationFilterReason | null
  fingerprint: string
  evidenceJson?: string | null
  writtenAt?: number | null
  error?: string | null
  beforeContent?: string | null
  afterContent?: string | null
  appendedText?: string | null
  sshConnectionId?: string | null
  createdAt: number
  updatedAt: number
  undoneAt?: number | null
}

export interface MemoryAutomationRecordInput {
  scope: MemoryAutomationScope
  rootScope?: MemoryRootScope | null
  memoryRootId?: string | null
  jobId?: string | null
  projectId?: string | null
  target: MemoryAutomationTarget
  kind: MemoryAutomationCandidateKind
  content: string
  confidence?: number
  sourceSessionId?: string | null
  targetPath?: string | null
  status: MemoryAutomationStatus
  filterReason?: MemoryAutomationFilterReason | null
  fingerprint: string
  evidence?: unknown
  evidenceJson?: string | null
  writtenAt?: number | null
  error?: string | null
  beforeContent?: string | null
  afterContent?: string | null
  appendedText?: string | null
  sshConnectionId?: string | null
}

export interface MemoryAutomationListQuery {
  id?: string
  memoryRootId?: string | null
  rootScope?: MemoryRootScope | null
  projectId?: string | null
  limit?: number
  offset?: number
  statuses?: MemoryAutomationStatus[]
  targets?: MemoryAutomationTarget[]
  sourceSessionId?: string | null
  targetPath?: string | null
  targetPathIncludes?: string | null
  fingerprint?: string | null
  includeContentSnapshots?: boolean
}

export interface MemoryAutomationListResult {
  entries: MemoryAutomationEntry[]
}

export interface MemoryAutomationRecordResult {
  success: boolean
  entry?: MemoryAutomationEntry
  error?: string
}

export interface MemoryAutomationUndoArgs {
  id: string
  status?: 'undone' | 'error'
  error?: string | null
}

export interface MemoryAutomationUndoResult {
  success: boolean
  entry?: MemoryAutomationEntry
  error?: string
}

export interface MemoryAutomationRunSessionArgs {
  sessionId: string
  assistantMessageId?: string | null
}

export interface MemoryAutomationRunSessionResult {
  success: boolean
  queued?: boolean
  error?: string
}

export interface MemoryAutomationRunRollupArgs {
  action?: 'get-watermark' | 'mark-watermark' | 'note-run'
  scope?: MemoryAutomationScope
  targetPath?: string | null
  sourceDate?: string | null
  contentHash?: string | null
}

export interface MemoryAutomationRunRollupResult {
  success: boolean
  alreadyProcessed?: boolean
  error?: string
}

export interface MemoryRootDescriptor {
  id: string
  scope: MemoryRootScope
  projectId?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
  rootPath: string
  transport: MemoryRootTransport
  ownerKey: string
  createdAt: number
  updatedAt: number
}

export interface MemoryRootInput {
  scope: MemoryRootScope
  projectId?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
  rootPath: string
  transport?: MemoryRootTransport
}

export interface MemoryStage1Output {
  id: string
  memoryRootId: string
  scope: MemoryRootScope
  sourceSessionId: string
  sourceUpdatedAt?: number | null
  rawMemory: string
  rolloutSummary: string
  rolloutSlug: string
  fingerprint: string
  status: 'active' | 'superseded' | 'filtered'
  usageCount: number
  lastUsageAt?: number | null
  createdAt: number
  updatedAt: number
}

export interface MemoryStage1OutputInput {
  memoryRootId: string
  scope: MemoryRootScope
  sourceSessionId: string
  sourceUpdatedAt?: number | null
  rawMemory: string
  rolloutSummary: string
  rolloutSlug: string
  fingerprint: string
  status?: 'active' | 'superseded' | 'filtered'
}

export interface MemoryPipelineJob {
  id: string
  kind: MemoryJobKind
  status: MemoryJobStatus
  memoryRootId?: string | null
  sourceSessionId?: string | null
  leaseOwner?: string | null
  leaseExpiresAt?: number | null
  attempts: number
  error?: string | null
  startedAt?: number | null
  finishedAt?: number | null
  createdAt: number
  updatedAt: number
}

export interface MemoryCitationEntry {
  scope: MemoryRootScope
  memoryRootId: string
  path: string
  line?: number | null
  sourceSessionId?: string | null
  citationJson?: string | null
}

export interface MemoryPipelineRunArgs {
  action:
    | 'prepare-session'
    | 'ensure-roots'
    | 'complete-stage1'
    | 'list-stage1-outputs'
    | 'complete-phase2'
    | 'record-job'
  sessionId?: string
  sourceUpdatedAt?: number | null
  roots?: MemoryRootInput[]
  jobId?: string | null
  status?: MemoryJobStatus
  error?: string | null
  stage1Outputs?: MemoryStage1OutputInput[]
  memoryRootId?: string | null
  jobKind?: MemoryJobKind
  leaseOwner?: string | null
  limit?: number
}

export interface MemoryPipelineRunResult {
  success: boolean
  roots?: MemoryRootDescriptor[]
  job?: MemoryPipelineJob
  jobs?: MemoryPipelineJob[]
  stage1Outputs?: MemoryStage1Output[]
  error?: string
}

export interface MemoryPipelineListRootsQuery {
  scope?: MemoryRootScope | 'both'
  projectId?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
  rootPath?: string | null
}

export interface MemoryPipelineListRootsResult {
  roots: MemoryRootDescriptor[]
}

export interface MemoryPipelineListJobsQuery {
  memoryRootId?: string | null
  sourceSessionId?: string | null
  statuses?: MemoryJobStatus[]
  kinds?: MemoryJobKind[]
  limit?: number
}

export interface MemoryPipelineListJobsResult {
  jobs: MemoryPipelineJob[]
}

export interface MemoryPipelineClearRootArgs {
  memoryRootId: string
  includeJobs?: boolean
}

export interface MemoryPipelineClearRootResult {
  success: boolean
  deletedStage1Outputs?: number
  deletedJobs?: number
  error?: string
}

export interface MemoryRecordCitationUsageResult {
  success: boolean
  error?: string
}
