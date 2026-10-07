import { nanoid } from 'nanoid'
import { getTsDatabaseRouteGuard } from './business-write-canary'
import { guardedCronWrite } from '../cron/cron-write-gate'
import { canaryGetCronJob, canaryGetCronRun, canaryListCronJobs } from './legacy-read-canary'
import { businessWriteCanary } from './business-write-canary'
import { loadOfflineWorkspaceIds } from '../remote/account-client'

export type CronScheduleKind = 'at' | 'every' | 'cron'
export type CronRunStatus = 'running' | 'success' | 'error' | 'aborted' | 'skipped'
export type CronRunLogType = 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
export interface CronRunDeliveryRecord {
  id: string
  run_id: string
  tool_call_id: string
  kind: 'desktop' | 'channel' | 'session'
  status: 'pending' | 'sent' | 'failed' | 'unknown'
  started_at: number
  finished_at: number | null
  error_code: string | null
  retry_of_id: string | null
  attempt_number: number
  plugin_id: string | null
  chat_id: string | null
}

export interface CronJobRecord {
  workspace_id?: string
  id: string
  name: string
  schedule_kind: CronScheduleKind
  schedule_at: number | null
  schedule_every: number | null
  schedule_expr: string | null
  schedule_tz: string
  prompt: string
  agent_id: string | null
  model: string | null
  /** Serialized public ModelSource; keys and account tickets are never stored here. */
  model_source?: string | null
  working_folder: string | null
  ssh_connection_id: string | null
  session_id: string | null
  source_session_title: string | null
  source_project_id: string | null
  source_project_name: string | null
  source_provider_id: string | null
  delivery_mode: 'desktop' | 'session' | 'none'
  delivery_target: string | null
  plugin_id: string | null
  plugin_chat_id: string | null
  enabled: number
  delete_after_run: number
  max_iterations: number
  deleted_at: number | null
  last_fired_at: number | null
  fire_count: number
  created_at: number
  updated_at: number
}

export interface CronRunRecord {
  id: string
  job_id: string
  started_at: number
  finished_at: number | null
  status: CronRunStatus
  tool_call_count: number
  output_summary: string | null
  error: string | null
  scheduled_for: number | null
  job_name_snapshot: string | null
  prompt_snapshot: string | null
  source_session_id_snapshot: string | null
  source_session_title_snapshot: string | null
  source_project_id_snapshot: string | null
  source_project_name_snapshot: string | null
  source_provider_id_snapshot: string | null
  model_snapshot: string | null
  /** Serialized public ModelSource selected when this attempt started. */
  model_source_snapshot: string | null
  working_folder_snapshot: string | null
  delivery_mode_snapshot: string | null
  delivery_target_snapshot: string | null
  run_kind?: 'scheduled' | 'manual' | 'trial'
  delivery_status?: 'pending' | 'sent' | 'failed' | 'unknown' | null
}

export interface CronRunMessageRow {
  id: string
  role: string
  content: string
  usage: string | null
  message_source: string | null
  created_at: number
}

export interface CronRunLogRow {
  id: string
  timestamp: number
  type: CronRunLogType
  content: string
}

export interface CronRunMessageInput {
  id: string
  role: string
  content: unknown
  usage?: unknown
  source?: string | null
  createdAt: number
}

export interface CronRunCreateArgs {
  runId: string
  jobId: string
  /** Explicit workspace required when the TS handover writer is enabled. */
  workspaceId?: string
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
  deliveryModeSnapshot?: string | null
  deliveryTargetSnapshot?: string | null
  runKind?: 'scheduled' | 'manual' | 'trial'
}

export interface CronRunUpdateArgs {
  runId: string
  /** Explicit workspace required when the TS handover writer is enabled. */
  workspaceId?: string
  patch: Partial<{
    finishedAt: number | null
    status: CronRunStatus
    toolCallCount: number
    outputSummary: string | null
    error: string | null
  }>
}

interface CronMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

interface CronJobFindResult {
  success: boolean
  job?: CronJobRecord | null
  error?: string | null
}

interface CronJobListResult {
  success: boolean
  jobs: CronJobRecord[]
  error?: string | null
}

interface CronRunFindResult {
  success: boolean
  run?: CronRunRecord | null
  error?: string | null
}

interface CronRunListResult {
  success: boolean
  runs: CronRunRecord[]
  error?: string | null
}

interface CronRunDetailResult {
  success: boolean
  run?: CronRunRecord | null
  job?: CronJobRecord | null
  messages: CronRunMessageRow[]
  logs: CronRunLogRow[]
  deliveries?: CronRunDeliveryRecord[]
  error?: string | null
}

interface CronRunDetailData {
  run: CronRunRecord
  job?: CronJobRecord | null
  messages: CronRunMessageRow[]
  logs: CronRunLogRow[]
  deliveries?: CronRunDeliveryRecord[]
}

interface CronStartupLoadResult {
  success: boolean
  jobs: CronJobRecord[]
  abortedRuns: number
  expiredJobs: number
  error?: string | null
}

function assertMutation(result: CronMutationResult, operation: string): CronMutationResult {
  if (!result.success) {
    throw new Error(result.error || `Native cron ${operation} failed`)
  }
  return result
}

async function cronMutation(method: string, params: object, operation: string): Promise<void> {
  await guardedCronWrite(async () => {
    const result = await getTsDatabaseRouteGuard().request<CronMutationResult>(
      method,
      params,
      120_000
    )
    assertMutation(result, operation)
  })
}

function toBusinessCronJob(job: CronJobRecord, workspaceId: string) {
  return {
    id: job.id,
    workspaceId,
    name: job.name,
    scheduleKind: job.schedule_kind,
    scheduleAt: job.schedule_at,
    scheduleEvery: job.schedule_every,
    scheduleExpr: job.schedule_expr,
    scheduleTz: job.schedule_tz,
    prompt: job.prompt,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    agentId: job.agent_id,
    model: job.model,
    modelSource: job.model_source,
    workingFolder: job.working_folder,
    sshConnectionId: job.ssh_connection_id,
    sessionId: job.session_id,
    sourceSessionTitle: job.source_session_title,
    sourceProjectId: job.source_project_id,
    sourceProjectName: job.source_project_name,
    sourceProviderId: job.source_provider_id,
    deliveryMode: job.delivery_mode,
    deliveryTarget: job.delivery_target,
    pluginId: job.plugin_id,
    pluginChatId: job.plugin_chat_id,
    enabled: job.enabled !== 0,
    deleteAfterRun: job.delete_after_run !== 0,
    maxIterations: job.max_iterations
  }
}

function unwrapJob(result: CronJobFindResult, operation: string): CronJobRecord | null {
  if (!result.success) {
    throw new Error(result.error || `Native cron job ${operation} failed`)
  }
  return result.job ?? null
}

function unwrapJobList(result: CronJobListResult, operation: string): CronJobRecord[] {
  if (!result.success) {
    throw new Error(result.error || `Native cron job ${operation} failed`)
  }
  return result.jobs
}

function unwrapRun(result: CronRunFindResult, operation: string): CronRunRecord | null {
  if (!result.success) {
    throw new Error(result.error || `Native cron run ${operation} failed`)
  }
  return result.run ?? null
}

function unwrapRunList(
  result: CronRunListResult | CronRunRecord[],
  operation: string
): CronRunRecord[] {
  // The TS BusinessRepository route returns the rows directly. Legacy Native
  // adapters return the historical `{ success, runs }` envelope.
  if (Array.isArray(result)) return result
  if (!result.success) {
    throw new Error(result.error || `Native cron run ${operation} failed`)
  }
  return result.runs
}

export async function createCronJob(job: CronJobRecord): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!job.workspace_id) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.createCronJob(toBusinessCronJob(job, job.workspace_id))
    return
  }
  await cronMutation('db/cron-jobs-create', { job, workspaceId: job.workspace_id }, 'create')
}

export async function updateCronJob(job: CronJobRecord, workspaceId?: string): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    const scopedWorkspaceId = workspaceId ?? job.workspace_id
    if (!scopedWorkspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    const businessJob = toBusinessCronJob(job, scopedWorkspaceId)
    const {
      id: _id,
      workspaceId: _workspaceId,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...patch
    } = businessJob
    await writer.updateCronJob({
      id: job.id,
      workspaceId: scopedWorkspaceId,
      updatedAt: job.updated_at,
      patch
    })
    return
  }
  await cronMutation('db/cron-jobs-update', { job, workspaceId }, 'update')
}

export async function getCronJob(
  jobId: string,
  workspaceId?: string
): Promise<CronJobRecord | null> {
  const canary = await canaryGetCronJob({ jobId, workspaceId })
  if (canary !== undefined) return canary
  const result = await getTsDatabaseRouteGuard().request<CronJobFindResult>(
    'db/cron-jobs-get',
    { jobId, workspaceId },
    120_000
  )
  return unwrapJob(result, 'get')
}

export async function listCronJobs(args: {
  sessionId?: string | null
  includeDeleted?: boolean
  workspaceId?: string
}): Promise<CronJobRecord[]> {
  const canary = await canaryListCronJobs(args)
  if (canary !== undefined) return canary
  const result = await getTsDatabaseRouteGuard().request<CronJobListResult>(
    'db/cron-jobs-list',
    args,
    120_000
  )
  return unwrapJobList(result, 'list')
}

export async function softDeleteCronJob(
  jobId: string,
  now = Date.now(),
  workspaceId?: string
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.softDeleteCronJob({ id: jobId, workspaceId, deletedAt: now, updatedAt: now })
    return
  }
  await cronMutation(
    'db/cron-jobs-soft-delete',
    { jobId, deletedAt: now, updatedAt: now, workspaceId },
    'soft delete'
  )
}

export async function deleteCronJob(jobId: string, workspaceId?: string): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.deleteCronJob({ id: jobId, workspaceId })
    return
  }
  await cronMutation('db/cron-jobs-delete', { jobId, workspaceId }, 'delete')
}

export async function setCronJobEnabled(
  jobId: string,
  enabled: boolean,
  updatedAt = Date.now(),
  workspaceId?: string
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.setCronJobEnabled({ id: jobId, workspaceId, enabled, updatedAt })
    return
  }
  await cronMutation(
    'db/cron-jobs-set-enabled',
    { jobId, enabled, updatedAt, workspaceId },
    'set enabled'
  )
}

export async function markCronJobFired(
  jobId: string,
  firedAt: number,
  workspaceId?: string
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    const changed = await writer.markCronJobFired({
      id: jobId,
      workspaceId,
      firedAt,
      updatedAt: firedAt
    })
    if (!changed) throw new Error('TS_CRON_JOB_NOT_FOUND')
    return
  }
  await cronMutation('db/cron-jobs-mark-fired', { jobId, firedAt }, 'mark fired')
}

export async function loadPersistedCronJobs(now = Date.now()): Promise<CronJobRecord[]> {
  const writer = businessWriteCanary()
  if (writer) {
    const workspaceIds = new Set(['local-personal'])
    try {
      for (const workspaceId of await loadOfflineWorkspaceIds()) workspaceIds.add(workspaceId)
    } catch (error) {
      console.warn(
        '[CronScheduler] offline workspace directory unavailable; using local workspace',
        {
          error: error instanceof Error ? error.message : String(error)
        }
      )
    }
    const jobs: CronJobRecord[] = []
    for (const workspaceId of workspaceIds) {
      const recovered = await writer.recoverCronJobs<CronJobRecord>(workspaceId, now)
      jobs.push(...recovered.jobs)
    }
    return jobs
  }
  return guardedCronWrite(async () => {
    const result = await getTsDatabaseRouteGuard().request<CronStartupLoadResult>(
      'db/cron-load-persisted-jobs',
      { now },
      120_000
    )
    if (!result.success) {
      throw new Error(result.error || 'Native cron load persisted jobs failed')
    }
    return result.jobs
  })
}

export async function listCronRuns(args: {
  jobId?: string
  sessionId?: string | null
  workspaceId?: string
  start?: number
  end?: number
  limit?: number
  offset?: number
  attentionOnly?: boolean
  anchor?: { at: number; id: string }
  after?: { at: number; id: string }
}): Promise<CronRunRecord[]> {
  // Delivery ledger rows live in the TS-owned database. Keep run history and
  // attention filtering on the same source so legacy read canaries cannot hide
  // a failed or unconfirmed delivery.
  const result = await getTsDatabaseRouteGuard().request<CronRunListResult>(
    'db/cron-runs-list',
    args,
    120_000
  )
  return unwrapRunList(result, 'list')
}

export async function createCronRun(args: CronRunCreateArgs): Promise<void> {
  const writer = businessWriteCanary()
  const workspaceId = args.workspaceId
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.createCronRun({
      id: args.runId,
      jobId: args.jobId,
      workspaceId,
      startedAt: args.startedAt,
      scheduledFor: args.scheduledFor,
      jobNameSnapshot: args.jobNameSnapshot,
      promptSnapshot: args.promptSnapshot,
      sourceSessionIdSnapshot: args.sourceSessionIdSnapshot,
      sourceSessionTitleSnapshot: args.sourceSessionTitleSnapshot,
      sourceProjectIdSnapshot: args.sourceProjectIdSnapshot,
      sourceProjectNameSnapshot: args.sourceProjectNameSnapshot,
      modelSnapshot: args.modelSnapshot,
      modelSourceSnapshot: args.modelSourceSnapshot,
      workingFolderSnapshot: args.workingFolderSnapshot,
      deliveryModeSnapshot: args.deliveryModeSnapshot as 'desktop' | 'session' | 'none' | undefined,
      deliveryTargetSnapshot: args.deliveryTargetSnapshot,
      runKind: args.runKind
    })
    return
  }
  await cronMutation('db/cron-runs-create', args, 'create run')
}

export async function updateCronRun(args: CronRunUpdateArgs): Promise<void> {
  const writer = businessWriteCanary()
  const workspaceId = args.workspaceId
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    // A TS runtime run is inserted as `running` by cron-run-start. There is
    // no second running-state mutation; only terminal transitions are writes.
    if (args.patch.status === 'running') return
    if (!args.patch.status) throw new Error('CRON_RUN_STATUS_REQUIRED')
    await writer.finishCronRun({
      id: args.runId,
      workspaceId,
      finishedAt: args.patch.finishedAt ?? Date.now(),
      status: args.patch.status,
      toolCallCount: args.patch.toolCallCount ?? 0,
      outputSummary: args.patch.outputSummary,
      error: args.patch.error
    })
    return
  }
  await cronMutation('db/cron-runs-update', args, 'update run')
}

export async function getCronRun(
  runId: string,
  workspaceId?: string
): Promise<CronRunRecord | null> {
  const canary = await canaryGetCronRun({ runId, workspaceId })
  if (canary !== undefined) return canary
  const result = await getTsDatabaseRouteGuard().request<CronRunFindResult>(
    'db/cron-runs-get',
    { runId, workspaceId },
    120_000
  )
  return unwrapRun(result, 'get')
}

export async function replaceCronRunMessages(
  runId: string,
  messages: CronRunMessageInput[],
  workspaceId?: string
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.replaceCronRunMessages({
      runId,
      workspaceId,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: JSON.stringify(message.content),
        usage: message.usage === undefined ? null : JSON.stringify(message.usage),
        source: message.source ?? null,
        createdAt: message.createdAt
      }))
    })
    return
  }
  await cronMutation(
    'db/cron-run-messages-replace',
    { runId, messages, workspaceId },
    'replace run messages'
  )
}

export async function appendCronRunLog(
  runId: string,
  timestamp: number,
  type: CronRunLogType,
  content: string,
  workspaceId?: string
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.appendCronRunLog({
      id: `log-${nanoid(8)}`,
      runId,
      workspaceId,
      timestamp,
      type,
      content
    })
    return
  }
  await cronMutation(
    'db/cron-run-log-append',
    { id: `log-${nanoid(8)}`, runId, timestamp, type, content, workspaceId },
    'append run log'
  )
}

export async function recordCronDelivery(args: {
  runId: string
  workspaceId: string
  toolCallId: string
  kind: 'desktop' | 'channel' | 'session'
  status: CronRunDeliveryRecord['status']
  startedAt: number
  finishedAt?: number | null
  errorCode?: string | null
  retryOfId?: string | null
  attemptNumber?: number
  pluginId?: string | null
  chatId?: string | null
}): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.recordCronDelivery({ id: `delivery-${nanoid(10)}`, ...args })
    return
  }
  await cronMutation(
    'db/cron-delivery-record',
    { id: `delivery-${nanoid(10)}`, ...args },
    'record delivery'
  )
}

export async function reconcileCronDelivery(args: {
  id: string
  runId: string
  workspaceId: string
  outcome: 'sent' | 'failed'
  confirmedAt: number
}): Promise<void> {
  const writer = businessWriteCanary()
  if (!writer) throw new Error('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
  const changed = await writer.reconcileCronDelivery(args)
  if (!changed) throw new Error('CRON_DELIVERY_NOT_RECONCILABLE')
}

export async function prepareCronDeliveryRetry(args: {
  id: string
  runId: string
  retryOfId: string
  workspaceId: string
  toolCallId: string
  startedAt: number
}): Promise<{ deliveryId: string; pluginId: string; chatId: string; attemptNumber: number }> {
  const writer = businessWriteCanary()
  if (!writer) throw new Error('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
  return writer.prepareCronDeliveryRetry(args)
}

export async function getCronRunDetail(
  runId: string,
  workspaceId?: string
): Promise<{
  run: CronRunRecord
  job: CronJobRecord | null
  messages: CronRunMessageRow[]
  logs: CronRunLogRow[]
  deliveries: CronRunDeliveryRecord[]
}> {
  // The run detail must read its delivery ledger from the TS-owned database.
  const result = await getTsDatabaseRouteGuard().request<CronRunDetailResult | CronRunDetailData>(
    'db/cron-run-detail',
    { runId, workspaceId },
    120_000
  )

  const legacyEnvelope = 'success' in result
  const run = legacyEnvelope ? result.run : result.run
  if ((legacyEnvelope && !result.success) || !run) {
    throw new Error((legacyEnvelope ? result.error : undefined) || `Run "${runId}" not found`)
  }
  return {
    run,
    job: result.job ?? null,
    messages: result.messages,
    logs: result.logs,
    deliveries: result.deliveries ?? []
  }
}
