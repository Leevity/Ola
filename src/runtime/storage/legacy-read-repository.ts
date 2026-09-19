import { Worker } from 'node:worker_threads'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ProjectWikiDocument } from '../../shared/project-wiki'
import type {
  MemoryAutomationEntry,
  MemoryAutomationListQuery,
  MemoryPipelineListRootsQuery,
  MemoryPipelineListJobsQuery,
  MemoryPipelineJob,
  MemoryRootDescriptor,
  MemoryStage1Output
} from '../../shared/memory-automation-types'

function legacyReadWorkerUrl(): URL {
  // electron-vite clears out/main on development rebuilds. The source Worker
  // remains available while the default Electron app is running.
  if ((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp)
    return new URL('../../src/runtime/storage/legacy-read-worker.mjs', import.meta.url)
  return new URL('./legacy-read-worker.mjs', import.meta.url)
}

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

export interface LegacyPluginSessionRow {
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
  workspace_id: string
  message_count: number
}

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

type WorkerMessage = { id: number; result?: unknown; error?: string }

/**
 * Transitional reader for the C#-owned business database. It is deliberately
 * read-only and has no generic SQL API, so it cannot become a second writer
 * before the explicit P8 ownership handover.
 */
export class LegacyReadRepository {
  private readonly worker: Worker
  private sequence = 0
  private failure: Error | null = null
  private closing = false
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  constructor(path: string) {
    this.worker = new Worker(legacyReadWorkerUrl(), {
      workerData: { path }
    })
    this.worker.on('message', (message: WorkerMessage) => {
      const request = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) request?.reject(new RuntimeError(message.error))
      else request?.resolve(message.result)
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', () => this.fail(new RuntimeError('LEGACY_REPOSITORY_CLOSED')))
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }

  private call<T>(method: string, args: object): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closing) return Promise.reject(new RuntimeError('LEGACY_REPOSITORY_CLOSED'))
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.worker.postMessage({ id, method, args })
    })
  }

  wikiDocument(projectRoot: string, workspaceId: string): Promise<ProjectWikiDocument | null> {
    return this.call('wiki-get', { projectRoot, workspaceId })
  }

  qqWakeupEligibility(input: {
    workspaceId: string
    pluginId: string
    openId: string
    now: number
  }): Promise<{
    enabled: boolean
    periodKey: string | null
    sourceMessageId: string | null
    sourceTimestamp: number
  }> {
    return this.call('qq-wakeup-resolve', input)
  }

  desktopFlows(workspaceId: string): Promise<string[]> {
    return this.call('desktop-flows-list', { workspaceId })
  }

  desktopFlowRuns(workspaceId: string, limit = 100): Promise<string[]> {
    return this.call('desktop-flow-runs-list', { workspaceId, limit })
  }

  drawRuns<T>(workspaceId: string): Promise<T[]> {
    return this.call('draw-runs-list', { workspaceId })
  }

  subAgentHistoryIndex<T>(sessionId: string, workspaceId: string, limit: number): Promise<T[]> {
    return this.call('sub-agent-history-index', { sessionId, workspaceId, limit })
  }

  subAgentHistoryPage<T>(args: {
    sessionId: string
    workspaceId: string
    limit: number
    offset: number
  }): Promise<T> {
    return this.call('sub-agent-history-list', args)
  }

  runtimeToolResults<T>(args: {
    sessionId: string
    workspaceId: string
    toolUseIds: string[]
  }): Promise<T[]> {
    return this.call('runtime-tool-results-lookup', args)
  }

  memoryRoots(
    query: MemoryPipelineListRootsQuery & { workspaceId: string }
  ): Promise<MemoryRootDescriptor[]> {
    return this.call('memory-roots-list', query)
  }

  memoryRoot(id: string, workspaceId: string): Promise<MemoryRootDescriptor | null> {
    return this.call('memory-root-get', { id, workspaceId })
  }

  memoryJobs(
    query: MemoryPipelineListJobsQuery & { workspaceId: string }
  ): Promise<MemoryPipelineJob[]> {
    return this.call('memory-jobs-list', query)
  }

  memoryJob(id: string, workspaceId: string): Promise<MemoryPipelineJob | null> {
    return this.call('memory-job-get', { id, workspaceId })
  }

  memoryStage1Outputs(args: {
    memoryRootId: string
    workspaceId: string
    limit?: number
  }): Promise<MemoryStage1Output[]> {
    return this.call('memory-stage1-list', args)
  }

  memoryAutomationEntries(
    query: MemoryAutomationListQuery & { workspaceId: string }
  ): Promise<MemoryAutomationEntry[]> {
    return this.call('memory-automation-list', query)
  }

  memoryAutomationEntry(id: string, workspaceId: string): Promise<MemoryAutomationEntry | null> {
    return this.call('memory-automation-get', { id, workspaceId })
  }

  cronJobs<T>(args: {
    workspaceId: string
    sessionId?: string | null
    includeDeleted?: boolean
  }): Promise<T[]> {
    return this.call('cron-jobs-list', args)
  }

  cronJob<T>(jobId: string, workspaceId: string): Promise<T | null> {
    return this.call('cron-job-get', { jobId, workspaceId })
  }

  cronRuns<T>(args: {
    workspaceId: string
    jobId?: string
    sessionId?: string | null
    start?: number
    end?: number
    limit?: number
  }): Promise<T[]> {
    return this.call('cron-runs-list', args)
  }

  cronRun<T>(runId: string, workspaceId: string): Promise<T | null> {
    return this.call('cron-run-get', { runId, workspaceId })
  }

  cronRunDetail<TRun, TJob, TMessage, TLog>(
    runId: string,
    workspaceId: string
  ): Promise<{
    run: TRun
    job: TJob | null
    messages: TMessage[]
    logs: TLog[]
  } | null> {
    return this.call('cron-run-detail', { runId, workspaceId })
  }

  sessions(workspaceId: string, limit = 200, offset = 0): Promise<LegacySessionRow[]> {
    return this.call('sessions-list', { workspaceId, limit, offset })
  }

  session(id: string, workspaceId: string): Promise<LegacySessionRow | null> {
    return this.call('session-get', { id, workspaceId })
  }

  channelSessionStatus(
    sessionId: string,
    workspaceId: string
  ): Promise<LegacyChannelSessionStatus> {
    return this.call('channel-session-status', { sessionId, workspaceId })
  }

  channelSessionUsageStats(
    sessionId: string,
    workspaceId: string
  ): Promise<LegacyChannelSessionUsageStats> {
    return this.call('channel-session-usage-stats', { sessionId, workspaceId })
  }

  usageEvents<T>(query: {
    workspaceId: string
    from: number
    to: number
    providerId?: string | null
    modelId?: string | null
    sourceKind?: string | null
    limit?: number
    offset?: number
  }): Promise<T[]> {
    return this.call('usage-events-list', query)
  }

  usageOverview<T>(query: {
    workspaceId: string
    from: number
    to: number
    providerId?: string | null
    modelId?: string | null
    sourceKind?: string | null
  }): Promise<T> {
    return this.call('usage-overview', query)
  }

  usageRawRows<T>(
    operation: 'daily' | 'timeline' | 'by-model' | 'by-provider',
    query: {
      workspaceId: string
      from: number
      to: number
      providerId?: string | null
      modelId?: string | null
      sourceKind?: string | null
      bucket?: 'hour' | 'day'
    }
  ): Promise<T[]> {
    return this.call('usage-raw-rows', { ...query, operation })
  }

  usageActivity<T>(
    operation:
      | 'activity-overview'
      | 'activity-daily'
      | 'activity-by-model'
      | 'activity-by-provider',
    query: {
      workspaceId: string
      from: number
      to: number
      limit?: number
      offset?: number
    }
  ): Promise<{ row?: T; rows?: T[] }> {
    return this.call('usage-activity', { ...query, operation })
  }

  projects(workspaceId: string, limit = 200, offset = 0): Promise<LegacyProjectRow[]> {
    return this.call('projects-list', { workspaceId, limit, offset })
  }

  allProjects(workspaceId: string): Promise<LegacyProjectRow[]> {
    return this.call('projects-list', { workspaceId, all: true })
  }

  project(id: string, workspaceId: string): Promise<LegacyProjectRow | null> {
    return this.call('project-get', { id, workspaceId })
  }

  projectByPlugin(pluginId: string, workspaceId: string): Promise<LegacyProjectRow | null> {
    return this.call('project-find-plugin', { pluginId, workspaceId })
  }

  pluginSessions(pluginId: string, workspaceId: string): Promise<LegacyPluginSessionRow[]> {
    return this.call('plugin-sessions-list', { pluginId, workspaceId })
  }

  allPluginSessions(workspaceId: string): Promise<LegacyPluginSessionRow[]> {
    return this.call('plugin-sessions-list-all', { workspaceId })
  }

  pluginSessionByChat(
    externalChatId: string,
    workspaceId: string
  ): Promise<LegacyPluginSessionRow | null> {
    return this.call('plugin-session-find-chat', { externalChatId, workspaceId })
  }

  pluginSessionMessages(
    sessionId: string,
    workspaceId: string,
    limit = 50,
    offset = 0
  ): Promise<LegacyPluginSessionMessageRow[]> {
    return this.call('plugin-session-messages', { sessionId, workspaceId, limit, offset })
  }

  tasks(workspaceId: string, limit = 200, offset = 0): Promise<LegacyTaskRow[]> {
    return this.call('tasks-list', { workspaceId, limit, offset })
  }

  allTasks(workspaceId: string): Promise<LegacyTaskRow[]> {
    return this.call('tasks-list', { workspaceId, all: true })
  }

  tasksBySession(
    sessionId: string,
    workspaceId: string,
    limit = 2000,
    offset = 0
  ): Promise<LegacyTaskRow[]> {
    return this.call('tasks-list-session', { sessionId, workspaceId, limit, offset })
  }

  allTasksBySession(sessionId: string, workspaceId: string): Promise<LegacyTaskRow[]> {
    return this.call('tasks-list-session', { sessionId, workspaceId, all: true })
  }

  task(id: string, workspaceId: string): Promise<LegacyTaskRow | null> {
    return this.call('task-get', { id, workspaceId })
  }

  plans(workspaceId: string, limit = 200, offset = 0): Promise<LegacyPlanRow[]> {
    return this.call('plans-list', { workspaceId, limit, offset })
  }

  allPlans(workspaceId: string): Promise<LegacyPlanRow[]> {
    return this.call('plans-list', { workspaceId, all: true })
  }

  plan(id: string, workspaceId: string): Promise<LegacyPlanRow | null> {
    return this.call('plan-get', { id, workspaceId })
  }

  planBySession(sessionId: string, workspaceId: string): Promise<LegacyPlanRow | null> {
    return this.call('plan-get-session', { sessionId, workspaceId })
  }

  goals(workspaceId: string): Promise<LegacyGoalRow[]> {
    return this.call('goals-list', { workspaceId })
  }

  goal(sessionId: string, workspaceId: string): Promise<LegacyGoalRow | null> {
    return this.call('goal-get', { sessionId, workspaceId })
  }

  goalEvents(args: {
    sessionId: string
    workspaceId: string
    goalId?: string | null
    limit?: number
  }): Promise<LegacyGoalEventRow[]> {
    return this.call('goal-events-list', args)
  }

  agentChangeSet(runId: string, workspaceId: string): Promise<LegacyAgentChangeSet | null> {
    return this.call('agent-change-get', { runId, workspaceId })
  }

  agentChangeSetsBySession(
    sessionId: string,
    workspaceId: string
  ): Promise<LegacyAgentChangeSet[]> {
    return this.call('agent-changes-list-session', { sessionId, workspaceId })
  }

  messages(sessionId: string, workspaceId: string): Promise<LegacyMessageRow[]> {
    return this.call('messages-list', { sessionId, workspaceId })
  }

  userMessages(sessionId: string, workspaceId: string): Promise<LegacyMessageRow[]> {
    return this.call('messages-list-user', { sessionId, workspaceId })
  }

  messageLocatorRows(sessionId: string, workspaceId: string): Promise<LegacyMessageLocatorRow[]> {
    return this.call('messages-list-locator', { sessionId, workspaceId })
  }

  messagesPage(
    sessionId: string,
    workspaceId: string,
    limit = 200,
    offset = 0
  ): Promise<LegacyMessageRow[]> {
    return this.call('messages-list-page', { sessionId, workspaceId, limit, offset })
  }

  messageMarkers(sessionId: string, workspaceId: string): Promise<LegacyMessageRow[]> {
    return this.call('messages-list-markers', { sessionId, workspaceId })
  }

  messageCount(sessionId: string, workspaceId: string): Promise<number> {
    return this.call('messages-count', { sessionId, workspaceId })
  }

  messageRequestContext(
    sessionId: string,
    workspaceId: string,
    maxMessages: number,
    headLimit?: number
  ): Promise<LegacyMessageRow[]> {
    return this.call('messages-request-context', {
      sessionId,
      workspaceId,
      maxMessages,
      headLimit
    })
  }

  messageWindowAround(
    sessionId: string,
    workspaceId: string,
    input: { messageId?: string | null; sortOrder?: number | null; limit: number }
  ): Promise<LegacyMessageWindowResult> {
    return this.call('messages-window-around', { sessionId, workspaceId, ...input })
  }

  searchMessageContent(
    query: string,
    workspaceId: string,
    limit?: number
  ): Promise<LegacyMessageContentMatch[]> {
    return this.call('messages-search-content', { query, workspaceId, limit })
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    await this.worker.terminate()
  }
}
