import { Worker } from 'node:worker_threads'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ProjectWikiDocument } from '../../shared/project-wiki'
import type { DesktopFlow, DesktopFlowRun } from '../../shared/desktop-flow'
import type {
  RuntimeJobEventRecord,
  RuntimeJobMutationResult,
  RuntimeJobRecord,
  RuntimeJobReapResult,
  RuntimeJobState
} from '../../shared/runtime-job-contract'
import type {
  SubAgentHistoryPage,
  SubAgentHistoryRow,
  SubAgentHistoryMigrationStatus,
  SubAgentHistoryUpsertItem
} from '../../shared/sub-agent-history-types'

type WorkerMessage = { id: number; result?: unknown; error?: string }

export interface BusinessCronJobInput {
  id: string
  workspaceId: string
  name: string
  scheduleKind: 'at' | 'every' | 'cron'
  scheduleAt?: number | null
  scheduleEvery?: number | null
  scheduleExpr?: string | null
  scheduleTz?: string | null
  prompt: string
  createdAt: number
  updatedAt?: number
  agentId?: string | null
  model?: string | null
  modelSource?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
  sessionId?: string | null
  sourceSessionTitle?: string | null
  sourceProjectId?: string | null
  sourceProjectName?: string | null
  sourceProviderId?: string | null
  deliveryMode?: 'desktop' | 'session' | 'none'
  deliveryTarget?: string | null
  pluginId?: string | null
  pluginChatId?: string | null
  enabled?: boolean
  deleteAfterRun?: boolean
  maxIterations?: number
}

export type BusinessCronJobPatch = Partial<
  Omit<BusinessCronJobInput, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'>
>

export interface BusinessCronRunInput {
  id: string
  jobId: string
  workspaceId: string
  startedAt: number
  scheduledFor?: number | null
  jobNameSnapshot?: string | null
  promptSnapshot?: string | null
  sourceSessionIdSnapshot?: string | null
  sourceSessionTitleSnapshot?: string | null
  sourceProjectIdSnapshot?: string | null
  sourceProjectNameSnapshot?: string | null
  sourceProviderIdSnapshot?: string | null
  modelSnapshot?: string | null
  modelSourceSnapshot?: string | null
  workingFolderSnapshot?: string | null
  deliveryModeSnapshot?: 'desktop' | 'session' | 'none'
  deliveryTargetSnapshot?: string | null
}

export interface BusinessUsageEventInput {
  id: string
  workspace_id: string
  created_at: number
  source_kind: string
  request_started_at?: number | null
  request_finished_at?: number | null
  session_id?: string | null
  message_id?: string | null
  project_id?: string | null
  provider_id?: string | null
  provider_name?: string | null
  provider_type?: string | null
  provider_builtin_id?: string | null
  provider_base_url?: string | null
  model_id?: string | null
  model_name?: string | null
  model_category?: string | null
  request_type?: string | null
  input_tokens?: number
  billable_input_tokens?: number | null
  output_tokens?: number
  cache_creation_tokens?: number | null
  cache_read_tokens?: number | null
  reasoning_tokens?: number | null
  context_tokens?: number | null
  input_price?: number | null
  output_price?: number | null
  cache_creation_price?: number | null
  cache_hit_price?: number | null
  input_cost_usd?: number | null
  output_cost_usd?: number | null
  cache_creation_cost_usd?: number | null
  cache_hit_cost_usd?: number | null
  total_cost_usd?: number | null
  ttft_ms?: number | null
  total_ms?: number | null
  tps?: number | null
  provider_response_id?: string | null
  request_debug_json?: string | null
  usage_raw_json?: string | null
  meta_json?: string | null
}

export interface BusinessUsageQuery {
  workspaceId: string
  from: number
  to: number
  providerId?: string | null
  modelId?: string | null
  sourceKind?: string | null
}

export interface BusinessDrawRunInput {
  id: string
  workspaceId: string
  prompt: string
  providerName: string
  modelName: string
  mode?: string
  metaJson?: string | null
  createdAt: number
  isGenerating: boolean
  imagesJson: string
  errorJson?: string | null
  updatedAt: number
}

export interface BusinessWorkspaceSyncBaseline {
  domain: string
  recordId: string
  contentHash: string
}

export interface BusinessWorkspaceSyncTombstone {
  domain: string
  recordId: string
  deletedAt: number
  originDeviceId: string
  workspaceId: string
}

export interface BusinessWorkspaceSyncMetadata {
  baseline: BusinessWorkspaceSyncBaseline[]
  tombstones: BusinessWorkspaceSyncTombstone[]
}

export interface BusinessAgentSnapshot {
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

export interface BusinessAgentFileChange {
  id: string
  runId: string
  sessionId?: string | null
  toolUseId?: string | null
  toolName?: string | null
  filePath: string
  transport: 'local' | 'ssh'
  connectionId?: string | null
  op: 'create' | 'modify'
  status: 'open' | 'reverted'
  before: BusinessAgentSnapshot
  after: BusinessAgentSnapshot
  createdAt: number
  revertedAt?: number | null
}

export interface BusinessAgentChangeSet {
  runId: string
  sessionId: string | null
  assistantMessageId: string
  status: 'open' | 'reverted'
  changes: BusinessAgentFileChange[]
  createdAt: number
  updatedAt: number
}

export interface BusinessRuntimeToolResultInput {
  workspaceId: string
  sessionId: string
  toolUseId: string
  runId: string
  toolName: string
  status: string
  contentJson: string
  isError: boolean
  startedAt?: number | null
  completedAt: number
}

export interface BusinessRuntimeJobInput {
  jobId: string
  workspaceId: string
  method: string
  paramsJson: string
  createdAt: number
  runId?: string | null
  sessionId?: string | null
  idempotencyKey?: string | null
  laneKey?: string | null
}

export interface BusinessRuntimeJobEventInput {
  jobId: string
  workspaceId: string
  seq: number
  payloadJson: string
  terminal: boolean
  createdAt: number
}

export interface BusinessMessageInput {
  id: string
  sessionId: string
  role: string
  content: string
  createdAt: number
  sortOrder: number
  meta?: string | null
  usage?: string | null
}

/**
 * TS-owned repository for a verified handover copy. It is deliberately never
 * pointed at the active Native Worker database; P8 promotes it only after the
 * legacy writer has stopped and the backup has passed its contract check.
 */
export class BusinessRepository {
  private readonly worker: Worker
  private sequence = 0
  private failure: Error | null = null
  private closing = false
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  constructor(input: { path: string; handoverManifestPath: string }) {
    this.worker = new Worker(new URL('./business-worker.mjs', import.meta.url), {
      workerData: input
    })
    this.worker.on('message', (message: WorkerMessage) => {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending?.reject(new RuntimeError(message.error))
      else pending?.resolve(message.result)
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', () => this.fail(new RuntimeError('BUSINESS_REPOSITORY_CLOSED')))
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private call<T>(method: string, args: object = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closing && method !== 'close')
      return Promise.reject(new RuntimeError('BUSINESS_REPOSITORY_CLOSED'))
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.worker.postMessage({ id, method, args })
    })
  }

  wikiDocument(projectRoot: string, workspaceId: string): Promise<ProjectWikiDocument | null> {
    return this.call('wiki-get', { projectRoot, workspaceId })
  }

  saveWikiDocument(
    document: ProjectWikiDocument,
    workspaceId: string,
    updatedAt: number
  ): Promise<boolean> {
    return this.call('wiki-save', { document, workspaceId, updatedAt })
  }

  deleteWikiDocument(projectRoot: string, workspaceId: string): Promise<boolean> {
    return this.call('wiki-delete', { projectRoot, workspaceId })
  }

  desktopFlows(workspaceId: string): Promise<DesktopFlow[]> {
    return this.call('desktop-flows-list', { workspaceId })
  }

  saveDesktopFlow(flow: DesktopFlow, workspaceId: string): Promise<boolean> {
    return this.call('desktop-flow-save', { flow, workspaceId })
  }

  deleteDesktopFlow(id: string, workspaceId: string): Promise<boolean> {
    return this.call('desktop-flow-delete', { id, workspaceId })
  }

  startDesktopFlowRun(
    id: string,
    flowId: string,
    workspaceId: string,
    startedAt: number
  ): Promise<boolean> {
    return this.call('desktop-flow-run-start', { id, flowId, workspaceId, startedAt })
  }

  finishDesktopFlowRun(
    id: string,
    workspaceId: string,
    state: 'succeeded' | 'failed' | 'cancelled',
    finishedAt: number,
    errorMessage?: string | null
  ): Promise<boolean> {
    return this.call('desktop-flow-run-finish', {
      id,
      workspaceId,
      state,
      finishedAt,
      errorMessage
    })
  }

  desktopFlowRuns(workspaceId: string, limit = 100): Promise<DesktopFlowRun[]> {
    return this.call('desktop-flow-runs-list', { workspaceId, limit })
  }

  submitRuntimeJob(input: BusinessRuntimeJobInput): Promise<RuntimeJobMutationResult> {
    return this.call('runtime-job-submit', input)
  }

  runtimeJob(jobId: string, workspaceId: string): Promise<RuntimeJobRecord | null> {
    return this.call('runtime-job-get', { jobId, workspaceId })
  }

  runtimeJobs(workspaceId: string, limit?: number): Promise<RuntimeJobRecord[]> {
    return this.call('runtime-jobs-list', { workspaceId, limit })
  }

  setRuntimeJobState(input: {
    jobId: string
    workspaceId: string
    state: RuntimeJobState
    updatedAt: number
    errorCode?: string | null
    errorMessage?: string | null
  }): Promise<RuntimeJobRecord | null> {
    return this.call('runtime-job-state', input)
  }

  cancelRuntimeJob(
    jobId: string,
    workspaceId: string,
    updatedAt: number
  ): Promise<RuntimeJobRecord | null> {
    return this.call('runtime-job-cancel', { jobId, workspaceId, updatedAt })
  }

  appendRuntimeJobEvent(input: BusinessRuntimeJobEventInput): Promise<boolean> {
    return this.call('runtime-job-event-append', input)
  }

  runtimeJobEvents(
    jobId: string,
    workspaceId: string,
    afterSeq?: number,
    limit?: number
  ): Promise<RuntimeJobEventRecord[]> {
    return this.call('runtime-job-events', { jobId, workspaceId, afterSeq, limit })
  }

  reapStaleRuntimeJobs(now: number, maxAgeMs?: number): Promise<RuntimeJobReapResult> {
    return this.call('runtime-jobs-reap-stale', { now, maxAgeMs })
  }

  drawRuns<T>(workspaceId: string): Promise<T[]> {
    return this.call('draw-runs-list', { workspaceId })
  }

  agentChangeSet(runId: string, workspaceId: string): Promise<BusinessAgentChangeSet | null> {
    return this.call('agent-change-get', { runId, workspaceId })
  }

  agentChangeSetsBySession(
    sessionId: string,
    workspaceId: string
  ): Promise<BusinessAgentChangeSet[]> {
    return this.call('agent-changes-list-session', { sessionId, workspaceId })
  }

  appendAgentFileChange(input: {
    runId: string
    workspaceId: string
    sessionId?: string | null
    assistantMessageId: string
    change: BusinessAgentFileChange
    now: number
  }): Promise<boolean> {
    return this.call('agent-change-append-file', input)
  }

  markAgentFileChangeReverted(input: {
    runId: string
    workspaceId: string
    changeId: string
    revertedAt: number
  }): Promise<boolean> {
    return this.call('agent-change-mark-reverted', input)
  }

  recomputeAgentChangeSet(runId: string, workspaceId: string, now: number): Promise<boolean> {
    return this.call('agent-change-recompute', { runId, workspaceId, now })
  }

  pruneFinalizedAgentChangeSets(cutoff: number): Promise<number> {
    return this.call('agent-changes-delete-finalized-before', { cutoff })
  }

  subAgentHistoryIndex(
    sessionId: string,
    workspaceId: string,
    limit?: number
  ): Promise<SubAgentHistoryRow[]> {
    return this.call('sub-agent-history-index', { sessionId, workspaceId, limit })
  }

  upsertRuntimeToolResult(input: BusinessRuntimeToolResultInput): Promise<boolean> {
    return this.call('runtime-tool-result-upsert', input)
  }

  runtimeToolResults<T>(
    sessionId: string,
    workspaceId: string,
    toolUseIds: string[]
  ): Promise<T[]> {
    return this.call('runtime-tool-results-lookup', { sessionId, workspaceId, toolUseIds })
  }

  subAgentHistoryPage(input: {
    sessionId: string
    workspaceId: string
    limit?: number
    offset?: number
  }): Promise<SubAgentHistoryPage> {
    return this.call('sub-agent-history-list', input)
  }

  applySubAgentHistory(item: SubAgentHistoryUpsertItem, workspaceId: string): Promise<number> {
    return this.call('sub-agent-history-apply', { ...item, workspaceId })
  }

  replaceSubAgentHistory(input: {
    sessionId: string
    workspaceId: string
    items: SubAgentHistoryUpsertItem[]
  }): Promise<number> {
    return this.call('sub-agent-history-replace', input)
  }

  subAgentHistoryMigrationStatus(key: string): Promise<SubAgentHistoryMigrationStatus> {
    return this.call('sub-agent-history-migration-status', { key })
  }

  markSubAgentHistoryMigration(key: string, appliedAt = Date.now()): Promise<number> {
    return this.call('sub-agent-history-migration-mark', { key, appliedAt })
  }

  saveDrawRun(input: BusinessDrawRunInput): Promise<boolean> {
    return this.call('draw-run-save', input)
  }

  applyDrawSyncBatch(input: {
    workspaceId: string
    records: BusinessDrawRunInput[]
    deletedIds: string[]
  }): Promise<{ saved: number; deleted: number }> {
    return this.call('draw-sync-apply', input)
  }

  validateWorkspaceDrawSyncIds(workspaceId: string, ids: string[]): Promise<boolean> {
    return this.call('workspace-draw-sync-validate-ids', { workspaceId, ids })
  }

  workspaceSyncMetadata(input: {
    scopeHash: string
    workspaceId: string
    providerId: string
  }): Promise<BusinessWorkspaceSyncMetadata> {
    return this.call('workspace-sync-metadata-get', input)
  }

  saveWorkspaceSyncMetadata(input: {
    scopeHash: string
    workspaceId: string
    providerId: string
    syncedAt: number
    baseline: BusinessWorkspaceSyncBaseline[]
    tombstones: BusinessWorkspaceSyncTombstone[]
  }): Promise<void> {
    return this.call('workspace-sync-metadata-save', input)
  }

  syncCaptureLocal(providerId: string): Promise<{
    records: Array<{ domain: string; recordId: string; value: unknown; updatedAt?: number | null }>
    baseline: Array<{ domain: string; recordId: string; contentHash: string }>
    tombstones: Array<{
      domain: string
      recordId: string
      deletedAt: number
      originDeviceId: string
    }>
  }> {
    return this.call('sync-capture-local', { providerId })
  }

  syncApplyDbMerge(input: {
    recordsToApply: unknown[]
    recordsToDelete: Array<{ domain: string; recordId: string }>
  }): Promise<{ success: boolean; changed: number; error?: string | null }> {
    return this.call('sync-apply-db-merge', input)
  }

  syncSaveMetadata(input: {
    providerId: string
    records: Array<{ domain: string; recordId: string; hash: string }>
    tombstones: Array<{
      domain: string
      recordId: string
      deletedAt: number
      originDeviceId: string
    }>
  }): Promise<{ success: boolean; changed: number; error?: string | null }> {
    return this.call('sync-save-metadata', input)
  }

  captureWorkspaceDrawSyncSnapshot<T>(input: {
    scopeHash: string
    workspaceId: string
    providerId: string
    deviceId: string
    createdAt: number
  }): Promise<{
    rows: T[]
    tombstones: BusinessWorkspaceSyncTombstone[]
    baseline: BusinessWorkspaceSyncBaseline[]
    revisionToken: string
  }> {
    return this.call('workspace-draw-sync-capture', input)
  }

  commitWorkspaceDrawSync(input: {
    scopeHash: string
    workspaceId: string
    providerId: string
    expectedRevisionToken: string
    syncedAt: number
    records: BusinessDrawRunInput[]
    deletedIds: string[]
    expectedRows: unknown[]
    baseline: BusinessWorkspaceSyncBaseline[]
    tombstones: BusinessWorkspaceSyncTombstone[]
  }): Promise<{ saved: number; deleted: number; revisionToken: string }> {
    return this.call('workspace-draw-sync-commit', input)
  }

  deleteDrawRun(id: string, workspaceId: string): Promise<boolean> {
    return this.call('draw-run-delete', { id, workspaceId })
  }

  clearDrawRuns(workspaceId: string): Promise<number> {
    return this.call('draw-runs-clear', { workspaceId })
  }

  usageEvents<T>(input: BusinessUsageQuery & { limit?: number; offset?: number }): Promise<T[]> {
    return this.call('usage-events-list', input)
  }

  queryRawUsage<T>(
    operation: 'overview' | 'daily' | 'timeline' | 'by-model' | 'by-provider',
    input: BusinessUsageQuery & { bucket?: 'hour' | 'day' }
  ): Promise<{ row?: T; rows?: T[] }> {
    return this.call('usage-query-raw', { ...input, operation })
  }

  /** LegacyReadRepository-compatible overview projection for promoted handover reads. */
  async usageOverview<T>(input: BusinessUsageQuery): Promise<T> {
    const result = await this.queryRawUsage<T>('overview', input)
    return (result.row ?? null) as T
  }

  /** LegacyReadRepository-compatible grouped usage rows for promoted reads. */
  async usageRawRows<T>(
    operation: 'daily' | 'timeline' | 'by-model' | 'by-provider',
    input: BusinessUsageQuery & { bucket?: 'hour' | 'day' }
  ): Promise<T[]> {
    const result = await this.queryRawUsage<T>(operation, input)
    return result.rows ?? []
  }

  queryActivityUsage<T>(
    operation:
      | 'activity-overview'
      | 'activity-daily'
      | 'activity-by-model'
      | 'activity-by-provider',
    input: BusinessUsageQuery & { limit?: number; offset?: number }
  ): Promise<{ row?: T; rows?: T[] }> {
    return this.call('usage-query-activity', { ...input, operation })
  }

  addUsageEvent(input: BusinessUsageEventInput): Promise<{
    id: string
    created_at: number
    workspace_id: string
  }> {
    return this.call('usage-event-add', input)
  }

  deleteUsageEvents(input: BusinessUsageQuery): Promise<number> {
    return this.call('usage-events-delete', input)
  }

  maintainUsage(cutoff: number): Promise<{ cutoff: number; deleted: number }> {
    return this.call('usage-maintain', { cutoff })
  }

  usageActivity<T>(input: {
    workspaceId: string
    fromDay: string
    toDay: string
    dimension: 'daily' | 'models' | 'providers'
    limit?: number
    offset?: number
  }): Promise<T[]> {
    return this.call('usage-activity-list', input)
  }

  sessions<T>(workspaceId: string, limit?: number, offset?: number): Promise<T[]> {
    return this.call('sessions-list', { workspaceId, limit, offset })
  }

  session<T>(id: string, workspaceId: string): Promise<T | null> {
    return this.call('session-get', { id, workspaceId })
  }

  channelSessions<T>(pluginId: string, workspaceId: string): Promise<T[]> {
    return this.call('channel-sessions-list', { pluginId, workspaceId })
  }

  allChannelSessions<T>(workspaceId: string): Promise<T[]> {
    return this.call('channel-sessions-list-all', { workspaceId })
  }

  channelSessionByChat<T>(externalChatId: string, workspaceId: string): Promise<T | null> {
    return this.call('channel-session-find-chat', { externalChatId, workspaceId })
  }

  channelSessionMessages<T>(
    sessionId: string,
    workspaceId: string,
    limit = 50,
    offset = 0
  ): Promise<T[]> {
    return this.call('channel-session-messages', { sessionId, workspaceId, limit, offset })
  }

  channelSessionStatus<T>(sessionId: string, workspaceId: string): Promise<T> {
    return this.call('channel-session-status', { sessionId, workspaceId })
  }

  channelSessionUsageStats<T>(sessionId: string, workspaceId: string): Promise<T> {
    return this.call('channel-session-usage-stats', { sessionId, workspaceId })
  }

  createChannelSession<T>(input: {
    id: string
    pluginId: string
    title: string
    workspaceId: string
    mode?: string
    createdAt?: number
    updatedAt?: number
    externalChatId?: string | null
    projectId?: string | null
    providerId?: string | null
    modelId?: string | null
  }): Promise<T> {
    return this.call('channel-session-create', input)
  }

  routeChannelSession(input: {
    pluginId: string
    chatId: string
    workspaceId: string
    chatName?: string | null
    senderName?: string | null
    projectId?: string | null
    providerId?: string | null
    modelId?: string | null
    modelSource?: string | null
  }): Promise<{
    sessionId: string
    sessionTitle: string
    projectId: string | null
    workingFolder: string | null
    sshConnectionId: string | null
  }> {
    return this.call('channel-session-route', input)
  }

  resolveQqWakeupEligibility(input: {
    pluginId: string
    openId: string
    workspaceId: string
    now: number
  }): Promise<{
    enabled: boolean
    periodKey: string | null
    sourceMessageId: string | null
    sourceTimestamp: number
  }> {
    return this.call('qq-wakeup-resolve', input)
  }

  qqWakeupEligibility(input: {
    pluginId: string
    openId: string
    workspaceId: string
    now: number
  }): ReturnType<BusinessRepository['resolveQqWakeupEligibility']> {
    return this.resolveQqWakeupEligibility(input)
  }

  recordQqWakeupSource(input: {
    pluginId: string
    openId: string
    workspaceId: string
    sourceMessageId: string
    sourceTimestamp: number
    now: number
  }): Promise<number> {
    return this.call('qq-wakeup-record-source', input)
  }

  markQqWakeupSent(input: {
    pluginId: string
    openId: string
    workspaceId: string
    periodKey: string
    sourceMessageId: string | null
    sourceTimestamp: number
    now: number
  }): Promise<number> {
    return this.call('qq-wakeup-mark-sent', input)
  }

  renameChannelSession(input: {
    sessionId: string
    workspaceId: string
    title: string
    updatedAt?: number
  }): Promise<boolean> {
    return this.call('channel-session-rename', input)
  }

  clearChannelSession(input: { sessionId: string; workspaceId: string }): Promise<number> {
    return this.call('channel-session-clear', input)
  }

  deleteChannelSession(input: { sessionId: string; workspaceId: string }): Promise<boolean> {
    return this.call('channel-session-delete', input)
  }

  removeChannelData(input: {
    pluginId: string
    workspaceId: string
  }): Promise<{ changed: number; deleted: number }> {
    return this.call('channel-data-remove', input)
  }

  projects<T>(workspaceId: string, limit?: number, offset?: number): Promise<T[]> {
    return this.call('projects-list', { workspaceId, limit, offset })
  }

  allProjects<T>(workspaceId: string): Promise<T[]> {
    return this.call('projects-list', { workspaceId, limit: 10_000, offset: 0 })
  }

  project<T>(id: string, workspaceId: string): Promise<T | null> {
    return this.call('project-get', { id, workspaceId })
  }

  projectByPlugin<T>(pluginId: string, workspaceId: string): Promise<T | null> {
    return this.call('project-find-by-plugin', { pluginId, workspaceId })
  }

  pluginSessions<T>(pluginId: string, workspaceId: string): Promise<T[]> {
    return this.call('channel-sessions-list', { pluginId, workspaceId })
  }

  allPluginSessions<T>(workspaceId: string): Promise<T[]> {
    return this.call('channel-sessions-list-all', { workspaceId })
  }

  pluginSessionByChat<T>(externalChatId: string, workspaceId: string): Promise<T | null> {
    return this.call('channel-session-find-chat', { externalChatId, workspaceId })
  }

  pluginSessionMessages<T>(
    sessionId: string,
    workspaceId: string,
    limit = 50,
    offset = 0
  ): Promise<T[]> {
    return this.call('channel-session-messages', { sessionId, workspaceId, limit, offset })
  }

  normalPluginProjects<T>(workspaceId: string): Promise<T[]> {
    return this.call('plugin-normal-projects', { workspaceId })
  }

  syncPluginSessionModels(input: {
    pluginId: string
    workspaceId: string
    providerId?: string | null
    modelId?: string | null
    modelSource?: string | null
  }): Promise<{ success: boolean; changed: number; deleted: number; error: string | null }> {
    return this.call('plugin-sync-session-models', input)
  }

  syncPluginSessionProject(input: {
    pluginId: string
    workspaceId: string
    projectId?: string | null
  }): Promise<{ success: boolean; changed: number; deleted: number; error: string | null }> {
    return this.call('plugin-sync-session-project', input)
  }

  removePluginData(input: {
    pluginId: string
    workspaceId: string
  }): Promise<{ success: boolean; changed: number; deleted: number; error: string | null }> {
    return this.call('plugin-remove-data', input)
  }

  messages<T>(sessionId: string, workspaceId: string): Promise<T[]> {
    return this.call('messages-list', { sessionId, workspaceId })
  }

  userMessages<T>(sessionId: string, workspaceId: string): Promise<T[]> {
    return this.call('messages-list-user', { sessionId, workspaceId })
  }

  messageLocatorRows<T>(sessionId: string, workspaceId: string): Promise<T[]> {
    return this.call('messages-list-locator', { sessionId, workspaceId })
  }

  messageMarkers<T>(sessionId: string, workspaceId: string): Promise<T[]> {
    return this.call('messages-list-markers', { sessionId, workspaceId })
  }

  messagesPage<T>(
    sessionId: string,
    workspaceId: string,
    limit?: number,
    offset?: number
  ): Promise<T[]> {
    return this.call('messages-list-page', { sessionId, workspaceId, limit, offset })
  }

  messageCount(sessionId: string, workspaceId: string): Promise<number> {
    return this.call('messages-count', { sessionId, workspaceId })
  }

  messageRequestContext<T>(
    sessionId: string,
    workspaceId: string,
    maxMessages: number,
    headLimit?: number
  ): Promise<T[]> {
    return this.call('messages-request-context', {
      sessionId,
      workspaceId,
      maxMessages,
      headLimit
    })
  }

  searchMessageContent<T>(query: string, workspaceId: string, limit?: number): Promise<T[]> {
    return this.call('messages-search-content', { query, workspaceId, limit })
  }

  messageWindowAround<T>(
    sessionId: string,
    workspaceId: string,
    input: { messageId?: string | null; sortOrder?: number | null; limit: number }
  ): Promise<{
    success: boolean
    rows: T[]
    start: number
    end: number
    total: number
    anchorSortOrder: number
  }> {
    return this.call('messages-window-around', { sessionId, workspaceId, ...input })
  }

  createSession<T>(input: {
    id: string
    title: string
    mode: string
    createdAt: number
    updatedAt: number
    workspaceId: string
    icon?: string | null
    projectId?: string | null
    workingFolder?: string | null
    sshConnectionId?: string | null
    planId?: string | null
    pinned?: boolean
    pluginId?: string | null
    externalChatId?: string | null
    providerId?: string | null
    modelId?: string | null
    modelSelectionMode?: string | null
    modelSource?: string | null
  }): Promise<T> {
    return this.call('session-create', input)
  }

  upsertMessage(input: {
    id: string
    sessionId: string
    workspaceId: string
    role: string
    content: string
    createdAt: number
    updatedAt: number
    sortOrder: number
    meta?: string | null
    usage?: string | null
  }): Promise<boolean> {
    return this.call('message-upsert', input)
  }

  addMessage(input: BusinessMessageInput & { workspaceId: string }): Promise<number> {
    return this.call('message-add', input)
  }

  addMessages(input: { workspaceId: string; messages: BusinessMessageInput[] }): Promise<number> {
    return this.call('messages-add-batch', input)
  }

  updateMessage(input: {
    id: string
    workspaceId: string
    patch: Partial<{ content: string; meta: string | null; usage: string | null }>
  }): Promise<number> {
    return this.call('message-update', input)
  }

  clearMessages(sessionId: string, workspaceId: string): Promise<number> {
    return this.call('messages-clear', { sessionId, workspaceId })
  }

  replaceMessages(input: {
    sessionId: string
    workspaceId: string
    messages: Omit<BusinessMessageInput, 'sessionId'>[]
  }): Promise<number> {
    return this.call('messages-replace', input)
  }

  truncateMessagesFrom(input: {
    sessionId: string
    workspaceId: string
    fromSortOrder: number
  }): Promise<number> {
    return this.call('messages-truncate-from', input)
  }

  deleteLastMessage<T>(input: {
    sessionId: string
    workspaceId: string
    role: string
  }): Promise<T | null> {
    return this.call('message-delete-last', input)
  }

  insertMessageArtifacts(input: {
    sessionId: string
    workspaceId: string
    insertSortOrder: number
    insertBeforeMessageId?: string | null
    messages: Omit<BusinessMessageInput, 'sessionId'>[]
  }): Promise<{ success: boolean; inserted: number; start: number; end: number; total: number }> {
    return this.call('messages-insert-artifacts', input)
  }

  deleteMessage(input: {
    id: string
    sessionId: string
    workspaceId: string
    updatedAt: number
  }): Promise<boolean> {
    return this.call('message-delete', input)
  }

  updateSession<T>(input: {
    id: string
    workspaceId: string
    updatedAt?: number
    title?: string
    icon?: string | null
    mode?: string
    projectId?: string | null
    workingFolder?: string | null
    sshConnectionId?: string | null
    planId?: string | null
    pinned?: boolean
    pluginId?: string | null
    externalChatId?: string | null
    providerId?: string | null
    modelId?: string | null
    modelSelectionMode?: string | null
    modelSource?: string | null
  }): Promise<T> {
    return this.call('session-update', input)
  }

  deleteSession(input: { id: string; workspaceId: string }): Promise<boolean> {
    return this.call('session-delete', input)
  }

  sessionStatus(input: { sessionId: string; workspaceId: string }): Promise<{
    success: boolean
    found: boolean
    title?: string
    createdAt?: number
    updatedAt?: number
    messageCount: number
  }> {
    return this.call('session-status', input)
  }

  sessionUsageStats(input: { sessionId: string; workspaceId: string }): Promise<{
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
    firstCreatedAt?: number
    lastCreatedAt?: number
  }> {
    return this.call('session-usage-stats', input)
  }

  compactSessionMessages(input: { sessionId: string; workspaceId: string }): Promise<{
    success: boolean
    totalMessages: number
    compacted: number
  }> {
    return this.call('session-compact-messages', input)
  }

  clearAllSessions(workspaceId: string): Promise<{
    success: boolean
    sessionIds: string[]
    deletedMessages: number
    deletedSessions: number
    error: string | null
  }> {
    return this.call('sessions-clear-all', { workspaceId })
  }

  resetConversation(input: { sessionId: string; workspaceId: string }): Promise<{
    success: boolean
    deletedMessages: number
    updatedAt: number
    error: string | null
  }> {
    return this.call('session-reset-conversation', input)
  }

  createProject<T>(input: {
    id: string
    name: string
    workspaceId: string
    createdAt: number
    updatedAt: number
    workingFolder?: string | null
    sshConnectionId?: string | null
    pluginId?: string | null
    pinned?: boolean
    modelSource?: string | null
  }): Promise<T> {
    return this.call('project-create', input)
  }

  updateProject<T>(input: {
    id: string
    workspaceId: string
    updatedAt?: number
    name?: string
    workingFolder?: string | null
    sshConnectionId?: string | null
    pluginId?: string | null
    pinned?: boolean
    modelSource?: string | null
  }): Promise<T> {
    return this.call('project-update', input)
  }

  deleteProject(input: { id: string; workspaceId: string }): Promise<boolean> {
    return this.call('project-delete', input)
  }

  ensureDefaultProject<T>(input: { workspaceId: string; baseDirectory: string }): Promise<T> {
    return this.call('project-ensure-default', input)
  }

  ensurePluginProject<T>(input: {
    pluginId: string
    workspaceId: string
    baseDirectory: string
    preferredName?: string
  }): Promise<T> {
    return this.call('project-ensure-plugin', input)
  }

  plans<T>(workspaceId: string, limit?: number, offset?: number): Promise<T[]> {
    return this.call('plans-list', { workspaceId, limit, offset })
  }

  allPlans<T>(workspaceId: string): Promise<T[]> {
    return this.call('plans-list', { workspaceId, limit: 10_000, offset: 0 })
  }

  plan<T>(id: string, workspaceId: string): Promise<T | null> {
    return this.call('plan-get', { id, workspaceId })
  }

  planBySession<T>(sessionId: string, workspaceId: string): Promise<T | null> {
    return this.call('plan-get-by-session', { sessionId, workspaceId })
  }

  createPlan<T>(input: {
    id: string
    sessionId: string
    workspaceId: string
    title: string
    createdAt: number
    updatedAt: number
    status?: string
    filePath?: string | null
    content?: string | null
    spec?: Record<string, unknown> | null
  }): Promise<T> {
    return this.call('plan-create', input)
  }

  updatePlan<T>(input: {
    id: string
    workspaceId: string
    updatedAt?: number
    title?: string
    status?: string
    filePath?: string | null
    content?: string | null
    spec?: Record<string, unknown> | null
  }): Promise<T> {
    return this.call('plan-update', input)
  }

  deletePlan(input: { id: string; workspaceId: string }): Promise<boolean> {
    return this.call('plan-delete', input)
  }

  goals<T>(workspaceId: string, limit?: number, offset?: number): Promise<T[]> {
    return this.call('goals-list', { workspaceId, limit, offset })
  }

  goal<T>(sessionId: string, workspaceId: string): Promise<T | null> {
    return this.call('goal-get', { sessionId, workspaceId })
  }

  goalEvents<T>(
    sessionId: string,
    workspaceId: string,
    options: { goalId?: string | null; limit?: number } = {}
  ): Promise<T[]> {
    return this.call('goal-events-list', { sessionId, workspaceId, ...options })
  }

  createGoal<T>(input: {
    sessionId: string
    workspaceId: string
    objective: string
    tokenBudget?: number | null
    goalId?: string
    createdAt?: number
  }): Promise<T | null> {
    return this.call('goal-create', input)
  }

  replaceGoal<T>(input: {
    sessionId: string
    workspaceId: string
    objective: string
    status?: string
    tokenBudget?: number | null
    goalId?: string
    createdAt?: number
  }): Promise<T> {
    return this.call('goal-replace', input)
  }

  updateGoal<T>(input: {
    sessionId: string
    workspaceId: string
    patch: { objective?: string; status?: string; tokenBudget?: number | null }
    goalId?: string
    updatedAt?: number
  }): Promise<T | null> {
    return this.call('goal-update', input)
  }

  upsertGoal<T>(input: {
    sessionId: string
    workspaceId: string
    goalId: string
    objective: string
    status: string
    createdAt: number
    updatedAt: number
    tokenBudget?: number | null
    tokensUsed?: number
    timeUsedSeconds?: number
  }): Promise<T> {
    return this.call('goal-upsert', input)
  }

  accountGoalUsage<T>(input: {
    sessionId: string
    workspaceId: string
    timeDeltaSeconds: number
    tokenDelta: number
    expectedGoalId?: string | null
    updatedAt?: number
  }): Promise<T | null> {
    return this.call('goal-account-usage', input)
  }

  appendGoalEvent(input: {
    id: string
    sessionId: string
    workspaceId: string
    eventType: string
    createdAt: number
    goalId?: string | null
    message?: string | null
    metadata?: Record<string, unknown> | null
  }): Promise<boolean> {
    return this.call('goal-event-append', input)
  }

  deleteGoal(input: { sessionId: string; workspaceId: string }): Promise<boolean> {
    return this.call('goal-delete', input)
  }

  clearGoal(input: {
    sessionId: string
    workspaceId: string
  }): Promise<{ success: boolean; cleared: boolean; error: string | null }> {
    return this.call('goals-clear', input)
  }

  memoryRoots<T>(workspaceId: string, limit?: number, offset?: number): Promise<T[]> {
    return this.call('memory-roots-list', { workspaceId, limit, offset })
  }

  memoryRoot<T>(id: string, workspaceId: string): Promise<T | null> {
    return this.call('memory-root-get', { id, workspaceId })
  }

  ensureMemoryRoot<T>(input: {
    workspaceId: string
    scope: 'global' | 'project'
    rootPath: string
    transport: 'local' | 'ssh'
    projectId?: string | null
    workingFolder?: string | null
    sshConnectionId?: string | null
  }): Promise<T> {
    return this.call('memory-root-ensure', input)
  }

  memoryStage1Outputs<T>(
    rootId: string,
    workspaceId: string,
    limit?: number,
    offset?: number
  ): Promise<T[]> {
    return this.call('memory-stage1-list', { rootId, workspaceId, limit, offset })
  }

  memoryStage1Output<T>(id: string, workspaceId: string): Promise<T | null> {
    return this.call('memory-stage1-get', { id, workspaceId })
  }

  addMemoryStage1Output<T>(input: {
    workspaceId: string
    memoryRootId: string
    scope: 'global' | 'project'
    sourceSessionId: string
    rawMemory: string
    rolloutSummary: string
    rolloutSlug: string
    fingerprint: string
    sourceUpdatedAt?: number | null
    status?: 'active' | 'superseded' | 'filtered'
  }): Promise<T> {
    return this.call('memory-stage1-add', input)
  }

  clearMemoryRoot(input: {
    workspaceId: string
    memoryRootId: string
    includeJobs?: boolean
  }): Promise<{ deletedStage1Outputs: number; deletedJobs: number }> {
    return this.call('memory-root-clear', input)
  }

  memoryJobs<T>(workspaceId: string, limit?: number, offset?: number): Promise<T[]> {
    return this.call('memory-jobs-list', { workspaceId, limit, offset })
  }

  memoryJob<T>(id: string, workspaceId: string): Promise<T | null> {
    return this.call('memory-job-get', { id, workspaceId })
  }

  createMemoryJob<T>(input: {
    workspaceId: string
    kind: 'stage1' | 'phase2' | 'daily_rollup'
    status: 'pending' | 'running' | 'succeeded' | 'succeeded_no_output' | 'skipped' | 'failed'
    memoryRootId?: string | null
    sourceSessionId?: string | null
    leaseOwner?: string | null
  }): Promise<T> {
    return this.call('memory-job-create', input)
  }

  finishMemoryJob<T>(input: {
    id: string
    workspaceId: string
    status: 'succeeded' | 'succeeded_no_output' | 'skipped' | 'failed'
    error?: string | null
  }): Promise<T | null> {
    return this.call('memory-job-finish', input)
  }

  memoryAutomationEntries<T>(
    workspaceId: string,
    limit?: number,
    offset?: number,
    includeContentSnapshots = false
  ): Promise<T[]> {
    return this.call('memory-entries-list', {
      workspaceId,
      limit,
      offset,
      includeContentSnapshots
    })
  }

  memoryAutomationEntry<T>(id: string, workspaceId: string): Promise<T | null> {
    return this.call('memory-entry-get', { id, workspaceId })
  }

  recordMemoryAutomationEntry<T>(input: {
    workspaceId: string
    scope: string
    target: string
    kind: string
    content: string
    status: string
    fingerprint: string
    rootScope?: string | null
    memoryRootId?: string | null
    jobId?: string | null
    projectId?: string | null
    confidence?: number
    sourceSessionId?: string | null
    targetPath?: string | null
    filterReason?: string | null
    evidenceJson?: string | null
    writtenAt?: number | null
    error?: string | null
    beforeContent?: string | null
    afterContent?: string | null
    appendedText?: string | null
    sshConnectionId?: string | null
  }): Promise<T> {
    return this.call('memory-entry-record', input)
  }

  markMemoryAutomationUndo<T>(input: {
    id: string
    workspaceId: string
    status: 'undone' | 'error'
    error?: string | null
  }): Promise<T | null> {
    return this.call('memory-entry-undo', input)
  }

  memoryRollups<T>(workspaceId: string, limit?: number, offset?: number): Promise<T[]> {
    return this.call('memory-rollups-list', { workspaceId, limit, offset })
  }

  markMemoryRollup(input: {
    workspaceId: string
    scope: string
    target: string
    targetPath: string
    sourceDate: string
    contentHash: string
  }): Promise<boolean> {
    return this.call('memory-rollup-mark', input)
  }

  memoryCitationUsage<T>(
    rootId: string,
    workspaceId: string,
    limit?: number,
    offset?: number
  ): Promise<T[]> {
    return this.call('memory-citations-list', { rootId, workspaceId, limit, offset })
  }

  recordMemoryCitationUsage(input: {
    workspaceId: string
    memoryRootId: string
    scope: 'global' | 'project'
    path: string
    sourceSessionId?: string | null
    line?: number | null
    citationJson?: string | null
  }): Promise<number> {
    return this.call('memory-citation-record', input)
  }

  cronJobs<T>(
    workspaceId: string,
    options: { includeDeleted?: boolean; limit?: number; offset?: number } = {}
  ): Promise<T[]> {
    return this.call('cron-jobs-list', { workspaceId, ...options })
  }

  cronJob<T>(id: string, workspaceId: string): Promise<T | null> {
    return this.call('cron-job-get', { id, workspaceId })
  }

  recoverCronJobs<T>(
    workspaceId: string,
    now: number
  ): Promise<{
    jobs: T[]
    abortedRuns: number
    expiredJobs: number
  }> {
    return this.call('cron-recover', { workspaceId, now })
  }

  createCronJob(input: BusinessCronJobInput): Promise<boolean> {
    return this.call('cron-job-create', input)
  }

  updateCronJob(input: {
    id: string
    workspaceId: string
    updatedAt: number
    patch: BusinessCronJobPatch
  }): Promise<boolean> {
    return this.call('cron-job-update', input)
  }

  deleteCronJob(input: { id: string; workspaceId: string }): Promise<boolean> {
    return this.call('cron-job-delete', input)
  }

  cronRuns<T>(workspaceId: string, limit?: number, offset?: number): Promise<T[]> {
    return this.call('cron-runs-list', { workspaceId, limit, offset })
  }

  cronRunDetail<T>(runId: string, workspaceId: string): Promise<T | null> {
    return this.call('cron-run-detail', { runId, workspaceId })
  }

  async cronRun<T>(runId: string, workspaceId: string): Promise<T | null> {
    const detail = await this.cronRunDetail<{ run: T }>(runId, workspaceId)
    return detail?.run ?? null
  }

  markCronJobFired(input: {
    id: string
    workspaceId: string
    firedAt: number
    updatedAt?: number
  }): Promise<boolean> {
    return this.call('cron-job-mark-fired', input)
  }

  setCronJobEnabled(input: {
    id: string
    workspaceId: string
    enabled: boolean
    updatedAt: number
  }): Promise<boolean> {
    return this.call('cron-job-set-enabled', input)
  }

  softDeleteCronJob(input: {
    id: string
    workspaceId: string
    deletedAt: number
    updatedAt?: number
  }): Promise<boolean> {
    return this.call('cron-job-soft-delete', input)
  }

  createCronRun(input: BusinessCronRunInput): Promise<boolean> {
    return this.call('cron-run-create', input)
  }

  startCronRun(input: BusinessCronRunInput & { firedAt: number }): Promise<{
    started: boolean
    runId?: string
    reason?: 'already-fired' | 'already-running' | 'duplicate-schedule'
  }> {
    return this.call('cron-run-start', input)
  }

  finishCronRun(input: {
    id: string
    workspaceId: string
    finishedAt: number
    status: 'success' | 'error' | 'aborted' | 'skipped'
    toolCallCount: number
    outputSummary?: string | null
    error?: string | null
  }): Promise<boolean> {
    return this.call('cron-run-finish', input)
  }

  replaceCronRunMessages(input: {
    runId: string
    workspaceId: string
    messages: Array<{
      id: string
      role: string
      content: string
      usage?: string | null
      source?: string | null
      createdAt: number
    }>
  }): Promise<boolean> {
    return this.call('cron-run-replace-messages', input)
  }

  appendCronRunLog(input: {
    id: string
    runId: string
    workspaceId: string
    timestamp: number
    type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
    content: string
  }): Promise<boolean> {
    return this.call('cron-run-append-log', input)
  }

  createTask(input: {
    id: string
    sessionId: string
    workspaceId: string
    subject: string
    description: string
    sortOrder: number
    createdAt: number
    updatedAt: number
    planId?: string | null
    activeForm?: string | null
    status?: string
    owner?: string | null
    blocks?: string[]
    blockedBy?: string[]
    metadata?: Record<string, unknown> | null
  }): Promise<boolean> {
    return this.call('task-create', input)
  }

  updateTask(input: {
    id: string
    workspaceId: string
    updatedAt?: number
    planId?: string | null
    subject?: string
    description?: string
    activeForm?: string | null
    status?: string
    owner?: string | null
    blocks?: string[]
    blockedBy?: string[]
    metadata?: Record<string, unknown> | null
    sortOrder?: number
  }): Promise<boolean> {
    return this.call('task-update', input)
  }

  deleteTask(input: { id: string; workspaceId: string }): Promise<boolean> {
    return this.call('task-delete', input)
  }

  deleteTasksBySession(input: { sessionId: string; workspaceId: string }): Promise<number> {
    return this.call('tasks-delete-by-session', input)
  }

  tasks<T>(workspaceId: string, limit?: number, offset?: number): Promise<T[]> {
    return this.call('tasks-list', { workspaceId, limit, offset })
  }

  allTasks<T>(workspaceId: string): Promise<T[]> {
    return this.call('tasks-list', { workspaceId, limit: 10_000, offset: 0 })
  }

  tasksBySession<T>(
    sessionId: string,
    workspaceId: string,
    limit?: number,
    offset?: number
  ): Promise<T[]> {
    return this.call('tasks-list-session', { sessionId, workspaceId, limit, offset })
  }

  allTasksBySession<T>(sessionId: string, workspaceId: string): Promise<T[]> {
    return this.call('tasks-list-session', { sessionId, workspaceId, limit: 10_000, offset: 0 })
  }

  task<T>(id: string, workspaceId: string): Promise<T | null> {
    return this.call('task-get', { id, workspaceId })
  }

  migrationStatus(): Promise<Array<{ version: number; applied_at: number; description: string }>> {
    return this.call('migration-status')
  }

  normalizeMessageSortOrders(): Promise<{
    repairedSessions: number
    repairedMessages: number
  }> {
    return this.call('normalize-message-sort-orders')
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    try {
      if (!this.failure) await this.call('close').catch(() => undefined)
    } finally {
      await this.worker.terminate()
    }
  }
}
