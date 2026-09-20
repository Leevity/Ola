export interface LegacySessionRow {
  id: string
  title: string
  icon: string | null
  mode: string
  created_at: number
  updated_at: number
  project_id: string | null
  working_folder: string | null
  ssh_connection_id: string | null
  plan_id: string | null
  pinned: number
  plugin_id: string | null
  external_chat_id: string | null
  provider_id: string | null
  model_id: string | null
  model_selection_mode: string | null
  model_source: string | null
  task_profile: string | null
  task_profile_locked: number
  workspace_id: string
  message_count: number
}

export interface LegacyPluginSessionRow extends LegacySessionRow {}

export interface LegacyPluginSessionMessageRow {
  id: string
  role: string
  content: string
  created_at: number
}

export interface LegacyChannelSessionStatus {
  success: boolean
  found: boolean
  title?: string | null
  createdAt?: number | null
  updatedAt?: number | null
  messageCount: number
}

export interface LegacyChannelSessionUsageStats {
  success: boolean
  hasUsage: boolean
  totalInput: number
  totalOutput: number
  totalCacheCreation: number
  totalCacheRead: number
  totalReasoning: number
  totalDurationMs: number
  requestCount: number
  assistantReplies: number
  firstCreatedAt?: number | null
  lastCreatedAt?: number | null
}

export interface LegacyProjectRow {
  id: string
  name: string
  working_folder: string | null
  ssh_connection_id: string | null
  plugin_id: string | null
  pinned: number
  created_at: number
  updated_at: number
  workspace_id: string
  model_source: string | null
}

export interface LegacyTaskRow {
  id: string
  session_id: string
  plan_id: string | null
  subject: string
  description: string
  active_form: string | null
  status: string
  owner: string | null
  blocks: string
  blocked_by: string
  metadata: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

export interface LegacyPlanRow {
  id: string
  session_id: string
  title: string
  status: string
  file_path: string | null
  content: string | null
  spec_json: string | null
  created_at: number
  updated_at: number
  workspace_id: string
}

export interface LegacyGoalRow {
  session_id: string
  goal_id: string
  objective: string
  status: string
  token_budget: number | null
  tokens_used: number
  time_used_seconds: number
  created_at: number
  updated_at: number
}

export interface LegacyGoalEventRow {
  id: string
  session_id: string
  goal_id: string | null
  event_type: string
  message: string | null
  metadata_json: string | null
  created_at: number
}

export interface LegacyMessageRow {
  id: string
  session_id: string
  role: string
  content: string
  meta: string | null
  created_at: number
  usage: string | null
  sort_order: number
}

export interface LegacyMessageLocatorRow {
  id: string
  session_id: string
  role: string
  content: string
  meta: string | null
  created_at: number
  sort_order: number
}

export interface LegacyMessageWindowResult {
  success: boolean
  rows: LegacyMessageRow[]
  start: number
  end: number
  total: number
  anchorSortOrder: number
  error?: string | null
}

export interface LegacyMessageContentMatch {
  session_id: string
  snippet: string
}

export interface LegacyAgentFileSnapshot {
  exists: boolean
  text?: string
  fullText?: string
  previewText?: string
  tailPreviewText?: string
  textOmitted?: boolean
  hash: string | null
  size: number
  lineCount?: number
}

export interface LegacyAgentFileChange {
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
  before: LegacyAgentFileSnapshot
  after: LegacyAgentFileSnapshot
  createdAt: number
  revertedAt?: number
}

export interface LegacyAgentChangeSet {
  runId: string
  sessionId?: string
  assistantMessageId: string
  status: 'open' | 'reverted'
  changes: LegacyAgentFileChange[]
  createdAt: number
  updatedAt: number
}
