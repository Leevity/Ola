import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { nanoid } from 'nanoid'
import cron from 'node-cron'
import { getRegisteredWindowWorkspace, getTrustedWorkspaceRegistrationWindow } from '../window-ipc'
import { sendCronWorkspaceEvent } from '../cron/cron-workspace-events'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import { authorizeCronWorkspace } from './cron-workspace-authorization'
import {
  scheduleJob,
  cancelJob,
  getScheduledJobIds,
  getActiveRunJobIds,
  markRunning,
  isCronWorkspaceSwitchPending,
  markFinished,
  recordSkippedCronRun
} from '../cron/cron-scheduler'
import {
  appendCronRunLog,
  createCronJob,
  createCronRun,
  deleteCronJob,
  getCronJob,
  getCronRun,
  getCronRunDetail,
  listCronJobs,
  listCronRuns,
  prepareCronDeliveryRetry,
  recordCronDelivery,
  replaceCronRunMessages,
  reconcileCronDelivery,
  setCronJobEnabled,
  softDeleteCronJob,
  updateCronJob,
  updateCronRun,
  type CronJobRecord,
  type CronRunRecord
} from '../db/cron-dao'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import { parseModelSource, type ModelSource } from '../../shared/runtime/model-source'
import { parseCronModelBinding } from '../../shared/runtime/cron-model-binding'
import {
  abortTsCronAgentRun,
  getTsCronExecutionState,
  runTsCronAgentInBackground
} from '../cron/ts-cron-agent-background'
import { classifyCronDeliveryResult } from '../cron/cron-delivery-tracking'
import { executeCronDeliveryRetry } from '../cron/cron-delivery-retry'
import type { CronAgentRunOptions } from '../cron/cron-runtime-types'

export interface CronAddArgs {
  workspaceId?: string
  name: string
  sessionId?: string
  schedule: {
    kind: 'at' | 'every' | 'cron'
    at?: number | string
    every?: number
    expr?: string
    tz?: string
  }
  prompt: string
  agentId?: string
  model?: string
  modelSource?: ModelSource | null
  workingFolder?: string
  sshConnectionId?: string | null
  deliveryMode?: 'desktop' | 'session' | 'none'
  deliveryTarget?: string
  deleteAfterRun?: boolean
  maxIterations?: number
  pluginId?: string
  pluginChatId?: string
  sourceSessionTitle?: string | null
  sourceProjectId?: string | null
  sourceProjectName?: string | null
  sourceProviderId?: string | null
}

export interface CronUpdateArgs {
  jobId: string
  workspaceId?: string
  sessionId?: string
  patch: Partial<{
    name: string
    schedule: {
      kind: 'at' | 'every' | 'cron'
      at?: number | string
      every?: number
      expr?: string
      tz?: string
    }
    prompt: string
    agentId: string | null
    model: string | null
    modelSource: ModelSource | null
    workingFolder: string | null
    sshConnectionId: string | null
    deliveryMode: 'desktop' | 'session' | 'none'
    deliveryTarget: string | null
    enabled: boolean
    deleteAfterRun: boolean
    maxIterations: number
    sessionId: string | null
    sourceSessionTitle: string | null
    sourceProjectId: string | null
    sourceProjectName: string | null
    sourceProviderId: string | null
  }>
}

interface CronRunCreateArgs {
  workspaceId: string
  runId: string
  jobId: string
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
  workingFolderSnapshot?: string | null
  deliveryModeSnapshot?: string | null
  deliveryTargetSnapshot?: string | null
}

interface CronRunUpdateArgs {
  workspaceId: string
  runId: string
  patch: Partial<{
    finishedAt: number | null
    status: 'running' | 'success' | 'error' | 'aborted' | 'skipped'
    toolCallCount: number
    outputSummary: string | null
    error: string | null
  }>
}

interface CronRunMessageInput {
  id: string
  role: string
  content: unknown
  usage?: unknown
  source?: string | null
  createdAt: number
}

interface CronRunMessagesReplaceArgs {
  workspaceId: string
  runId: string
  messages: CronRunMessageInput[]
}

interface CronRunLogAppendArgs {
  workspaceId: string
  runId: string
  timestamp: number
  type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
  content: string
}

function registerCronMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    try {
      await authorizeCronRequestWorkspace(event, args)
    } catch (error) {
      return encodeMessagePackPayload({
        error: error instanceof Error ? error.message : 'cron-workspace-unavailable'
      })
    }
    const result = await handler(args)
    try {
      await authorizeCronRequestWorkspace(event, args)
    } catch (error) {
      return encodeMessagePackPayload({
        error: error instanceof Error ? error.message : 'cron-workspace-unavailable'
      })
    }
    return encodeMessagePackPayload(result)
  })
}

async function authorizeCronRequestWorkspace(
  event: IpcMainInvokeEvent,
  args: unknown
): Promise<string> {
  const win = getTrustedWorkspaceRegistrationWindow(event)
  if (!win) throw new Error('cron-window-untrusted')
  return authorizeCronWorkspace(args, getRegisteredWindowWorkspace(win), loadOfflineWorkspaceIds)
}

function resolveTimestamp(value: number | string | undefined): number | null {
  if (value == null) return null
  if (typeof value === 'number') return value
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function validateTimeZone(timeZone: string): string | null {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
    return null
  } catch {
    return `schedule.tz is not a valid IANA timezone: "${timeZone}"`
  }
}

function validateSchedule(schedule: CronAddArgs['schedule']): string | null {
  if (!schedule || !schedule.kind) return 'schedule.kind is required (at | every | cron)'
  if (schedule.kind === 'at') {
    const ts = resolveTimestamp(schedule.at)
    if (!ts) return 'schedule.at must be a valid timestamp (ms) or ISO 8601 string'
    if (ts < Date.now() - 30_000) {
      return `schedule.at is in the past (${new Date(ts).toISOString()}). Use a future timestamp.`
    }
  } else if (schedule.kind === 'every') {
    if (!schedule.every || schedule.every < 1000) return 'schedule.every must be >= 1000 ms'
  } else if (schedule.kind === 'cron') {
    const expr = schedule.expr?.trim()
    if (!expr) return 'schedule.expr is required for kind=cron'
    const parts = expr.split(/\s+/)
    if (parts.length < 5 || parts.length > 6) return 'schedule.expr must have 5 or 6 fields'
    if (!cron.validate(expr)) return `schedule.expr is not a valid cron expression: "${expr}"`
    const tzErr = validateTimeZone(schedule.tz?.trim() || 'UTC')
    if (tzErr) return tzErr
  } else {
    return `Unknown schedule.kind: "${schedule.kind}"`
  }
  return null
}

function parsePersistedModelSource(value: string | null | undefined): ModelSource | null {
  if (!value) return null
  try {
    return parseModelSource(JSON.parse(value))
  } catch {
    return null
  }
}

interface CronJobApi {
  id: string
  sessionId: string | null
  name: string
  schedule: {
    kind: 'at' | 'every' | 'cron'
    at: number | null
    every: number | null
    expr: string | null
    tz: string
  }
  prompt: string
  agentId: string | null
  model: string | null
  modelSource: ModelSource | null
  workingFolder: string | null
  sshConnectionId: string | null
  deliveryMode: 'desktop' | 'session' | 'none'
  deliveryTarget: string | null
  pluginId: string | null
  pluginChatId: string | null
  enabled: boolean
  deleteAfterRun: boolean
  maxIterations: number
  deletedAt: number | null
  lastFiredAt: number | null
  fireCount: number
  createdAt: number
  updatedAt: number
  sourceSessionTitle: string | null
  sourceProjectId: string | null
  sourceProjectName: string | null
  sourceProviderId: string | null
  workspaceId?: string
  scheduled: boolean
  executing: boolean
  executionStartedAt: number | null
  executionProgress: { iteration: number; toolCalls: number; currentStep?: string } | null
}

interface CronRunApi {
  id: string
  jobId: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'success' | 'error' | 'aborted' | 'skipped'
  toolCallCount: number
  outputSummary: string | null
  error: string | null
  scheduledFor: number | null
  jobNameSnapshot: string | null
  promptSnapshot: string | null
  sourceSessionIdSnapshot: string | null
  sourceSessionTitleSnapshot: string | null
  sourceProjectIdSnapshot: string | null
  sourceProjectNameSnapshot: string | null
  sourceProviderIdSnapshot: string | null
  modelSnapshot: string | null
  modelSourceSnapshot: string | null
  workingFolderSnapshot: string | null
  deliveryModeSnapshot: string | null
  deliveryTargetSnapshot: string | null
  runKind: 'scheduled' | 'manual' | 'trial'
  deliveryStatus: 'pending' | 'sent' | 'failed' | 'unknown' | null
}

interface CronRunMessageApi {
  id: string
  role: string
  content: unknown
  usage: unknown
  source: string | null
  createdAt: number
}

interface CronRunLogApi {
  id: string
  timestamp: number
  type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
  content: string
}

function parseJsonValue(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function jobToApi(
  r: CronJobRecord,
  scheduledIds: Set<string>,
  runningIds: Set<string>
): CronJobApi {
  const runtimeState = getTsCronExecutionState(r.id)
  return {
    id: r.id,
    sessionId: r.session_id,
    name: r.name,
    schedule: {
      kind: r.schedule_kind,
      at: r.schedule_at,
      every: r.schedule_every,
      expr: r.schedule_expr,
      tz: r.schedule_tz
    },
    prompt: r.prompt,
    agentId: r.agent_id,
    model: r.model,
    modelSource: parsePersistedModelSource(r.model_source),
    workingFolder: r.working_folder,
    sshConnectionId: r.ssh_connection_id,
    deliveryMode: r.delivery_mode,
    deliveryTarget: r.delivery_target,
    pluginId: r.plugin_id,
    pluginChatId: r.plugin_chat_id,
    enabled: Boolean(r.enabled),
    deleteAfterRun: Boolean(r.delete_after_run),
    maxIterations: r.max_iterations,
    deletedAt: r.deleted_at,
    lastFiredAt: r.last_fired_at,
    fireCount: r.fire_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sourceSessionTitle: r.source_session_title,
    sourceProjectId: r.source_project_id,
    sourceProjectName: r.source_project_name,
    sourceProviderId: r.source_provider_id,
    workspaceId: r.workspace_id ?? 'local-personal',
    scheduled: scheduledIds.has(r.id),
    executing: runningIds.has(r.id),
    executionStartedAt: runtimeState?.startedAt ?? null,
    executionProgress: runtimeState?.progress ?? null
  }
}

function runToApi(r: CronRunRecord): CronRunApi {
  return {
    id: r.id,
    jobId: r.job_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    toolCallCount: r.tool_call_count,
    outputSummary: r.output_summary,
    error: r.error,
    scheduledFor: r.scheduled_for,
    jobNameSnapshot: r.job_name_snapshot,
    promptSnapshot: r.prompt_snapshot,
    sourceSessionIdSnapshot: r.source_session_id_snapshot,
    sourceSessionTitleSnapshot: r.source_session_title_snapshot,
    sourceProjectIdSnapshot: r.source_project_id_snapshot,
    sourceProjectNameSnapshot: r.source_project_name_snapshot,
    sourceProviderIdSnapshot: r.source_provider_id_snapshot,
    modelSnapshot: r.model_snapshot,
    modelSourceSnapshot: r.model_source_snapshot,
    workingFolderSnapshot: r.working_folder_snapshot,
    deliveryModeSnapshot: r.delivery_mode_snapshot,
    deliveryTargetSnapshot: r.delivery_target_snapshot,
    runKind: r.run_kind ?? 'scheduled',
    deliveryStatus: r.delivery_status ?? null
  }
}

export async function handleCronAdd(args: CronAddArgs): Promise<unknown> {
  if (!args.name) return { error: 'name is required' }
  if (!args.prompt) return { error: 'prompt is required' }

  const schedErr = validateSchedule(args.schedule)
  if (schedErr) return { error: schedErr }

  const id = `cron-${nanoid(8)}`
  const now = Date.now()
  const kind = args.schedule.kind

  let modelSource: string | null = null
  try {
    modelSource = args.modelSource ? JSON.stringify(parseModelSource(args.modelSource)) : null
  } catch {
    return { error: 'modelSource is invalid' }
  }
  if (
    args.modelSource &&
    args.modelSource.kind !== 'local' &&
    args.modelSource.workspaceId !== (args.workspaceId ?? 'local-personal')
  )
    return { error: 'modelSource does not belong to workspace' }
  const record: CronJobRecord = {
    workspace_id: args.workspaceId ?? 'local-personal',
    id,
    name: args.name,
    session_id: args.sessionId ?? null,
    schedule_kind: kind,
    schedule_at: kind === 'at' ? resolveTimestamp(args.schedule.at) : null,
    schedule_every: kind === 'every' ? (args.schedule.every ?? null) : null,
    schedule_expr: kind === 'cron' ? (args.schedule.expr ?? null) : null,
    schedule_tz: args.schedule.tz ?? 'UTC',
    prompt: args.prompt,
    agent_id: args.agentId ?? null,
    model: args.model ?? null,
    model_source: modelSource,
    working_folder: args.workingFolder ?? null,
    ssh_connection_id: args.sshConnectionId ?? null,
    source_session_title: args.sourceSessionTitle ?? null,
    source_project_id: args.sourceProjectId ?? null,
    source_project_name: args.sourceProjectName ?? null,
    source_provider_id: args.sourceProviderId ?? null,
    delivery_mode: args.deliveryMode ?? 'desktop',
    delivery_target: args.deliveryTarget ?? null,
    plugin_id: args.pluginId ?? null,
    plugin_chat_id: args.pluginChatId ?? null,
    enabled: 1,
    delete_after_run: (args.deleteAfterRun ?? (kind === 'at' ? 1 : 0)) ? 1 : 0,
    max_iterations: args.maxIterations ?? 15,
    deleted_at: null,
    last_fired_at: null,
    fire_count: 0,
    created_at: now,
    updated_at: now
  }

  try {
    await createCronJob(record)
  } catch (err) {
    return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
  }

  const scheduled = scheduleJob(record)
  if (!scheduled) {
    try {
      await deleteCronJob(id)
    } catch {
      // ignore
    }
    return { error: `Failed to schedule job (kind=${kind})` }
  }

  return { success: true, jobId: id, name: args.name, schedule: args.schedule }
}

export async function handleCronUpdate(args: CronUpdateArgs): Promise<unknown> {
  if (!args.jobId) return { error: 'jobId is required' }
  if (!args.patch || Object.keys(args.patch).length === 0) return { error: 'patch is required' }

  try {
    const row = await getCronJob(args.jobId, args.workspaceId ?? 'local-personal')
    if (!row) return { error: `Job "${args.jobId}" not found` }
    if ((row.workspace_id ?? 'local-personal') !== (args.workspaceId ?? 'local-personal')) {
      return { error: `Job "${args.jobId}" not found` }
    }
    if (args.sessionId && row.session_id !== args.sessionId)
      return { error: `Job "${args.jobId}" not found` }

    const p = args.patch
    const updated: CronJobRecord = { ...row }

    if (p.name !== undefined) updated.name = p.name
    if (p.prompt !== undefined) updated.prompt = p.prompt
    if (p.agentId !== undefined) updated.agent_id = p.agentId
    if (p.model !== undefined) updated.model = p.model
    if (p.modelSource !== undefined) {
      try {
        const source = p.modelSource ? parseModelSource(p.modelSource) : null
        if (source && source.kind !== 'local' && source.workspaceId !== updated.workspace_id)
          return { error: 'modelSource does not belong to workspace' }
        updated.model_source = source ? JSON.stringify(source) : null
      } catch {
        return { error: 'modelSource is invalid' }
      }
    }
    if (p.workingFolder !== undefined) updated.working_folder = p.workingFolder
    if (p.sshConnectionId !== undefined) updated.ssh_connection_id = p.sshConnectionId
    if (p.deliveryMode !== undefined) updated.delivery_mode = p.deliveryMode
    if (p.deliveryTarget !== undefined) updated.delivery_target = p.deliveryTarget
    if (p.enabled !== undefined) updated.enabled = p.enabled ? 1 : 0
    if (p.deleteAfterRun !== undefined) updated.delete_after_run = p.deleteAfterRun ? 1 : 0
    if (p.maxIterations !== undefined) updated.max_iterations = p.maxIterations
    if (p.sessionId !== undefined) updated.session_id = p.sessionId
    if (p.sourceSessionTitle !== undefined) updated.source_session_title = p.sourceSessionTitle
    if (p.sourceProjectId !== undefined) updated.source_project_id = p.sourceProjectId
    if (p.sourceProjectName !== undefined) updated.source_project_name = p.sourceProjectName
    if (p.sourceProviderId !== undefined) updated.source_provider_id = p.sourceProviderId

    if (p.schedule) {
      const schedErr = validateSchedule(p.schedule as CronAddArgs['schedule'])
      if (schedErr) return { error: schedErr }
      updated.schedule_kind = p.schedule.kind
      updated.schedule_at = p.schedule.kind === 'at' ? resolveTimestamp(p.schedule.at) : null
      updated.schedule_every = p.schedule.kind === 'every' ? (p.schedule.every ?? null) : null
      updated.schedule_expr = p.schedule.kind === 'cron' ? (p.schedule.expr?.trim() ?? null) : null
      updated.schedule_tz = p.schedule.kind === 'cron' ? p.schedule.tz?.trim() || 'UTC' : 'UTC'
    }

    updated.updated_at = Date.now()

    await updateCronJob(updated, args.workspaceId ?? 'local-personal')

    cancelJob(updated.id)
    if (updated.enabled && !updated.deleted_at) {
      const scheduled = scheduleJob(updated)
      if (!scheduled) {
        return { error: `Failed to schedule job (kind=${updated.schedule_kind})` }
      }
    }

    return { success: true, jobId: args.jobId }
  } catch (err) {
    return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function handleCronRemove(args: {
  jobId: string
  workspaceId?: string
  sessionId?: string
}): Promise<unknown> {
  if (!args.jobId) return { error: 'jobId is required' }

  try {
    const row = await getCronJob(args.jobId, args.workspaceId ?? 'local-personal')
    if (!row) return { error: `Job "${args.jobId}" not found` }
    if ((row.workspace_id ?? 'local-personal') !== (args.workspaceId ?? 'local-personal'))
      return { error: `Job "${args.jobId}" not found` }
    if (args.sessionId && row.session_id !== args.sessionId)
      return { error: `Job "${args.jobId}" not found` }

    cancelJob(args.jobId)
    await softDeleteCronJob(args.jobId, Date.now(), args.workspaceId ?? 'local-personal')
    return { success: true, jobId: args.jobId }
  } catch (err) {
    return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function handleCronDelete(args: {
  jobId: string
  workspaceId?: string
  sessionId?: string
}): Promise<unknown> {
  if (!args.jobId) return { error: 'jobId is required' }

  try {
    const row = await getCronJob(args.jobId, args.workspaceId ?? 'local-personal')
    if (!row) return { error: `Job "${args.jobId}" not found` }
    if ((row.workspace_id ?? 'local-personal') !== (args.workspaceId ?? 'local-personal'))
      return { error: `Job "${args.jobId}" not found` }
    if (args.sessionId && row.session_id !== args.sessionId)
      return { error: `Job "${args.jobId}" not found` }

    cancelJob(args.jobId)
    // Hard delete: cascading FK constraints remove related cron run rows.
    await deleteCronJob(args.jobId, args.workspaceId ?? 'local-personal')
    return { success: true, jobId: args.jobId }
  } catch (err) {
    return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function handleCronList(
  args?: { sessionId?: string | null; includeDeleted?: boolean; workspaceId?: string } | null
): Promise<unknown> {
  try {
    const scheduledIds = new Set(getScheduledJobIds())
    const runningIds = new Set(getActiveRunJobIds())
    const rows = await listCronJobs({
      sessionId: args?.sessionId,
      includeDeleted: Boolean(args?.includeDeleted),
      workspaceId: args?.workspaceId
    })

    return rows.map((r) => jobToApi(r, scheduledIds, runningIds))
  } catch (err) {
    return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function registerCronHandlers(): void {
  registerCronMessagePackHandler<CronAddArgs>('cron:add', async (args) => {
    return await handleCronAdd(args)
  })

  registerCronMessagePackHandler<CronUpdateArgs>('cron:update', async (args) => {
    return await handleCronUpdate(args)
  })

  registerCronMessagePackHandler<{ jobId: string; workspaceId?: string }>(
    'cron:remove',
    async (args) => {
      return await handleCronRemove(args)
    }
  )

  registerCronMessagePackHandler<{ jobId: string; workspaceId?: string }>(
    'cron:delete',
    async (args) => {
      return await handleCronDelete(args)
    }
  )

  registerCronMessagePackHandler<
    { sessionId?: string | null; includeDeleted?: boolean; workspaceId?: string } | undefined
  >('cron:list', async (args) => {
    return await handleCronList(args)
  })

  registerCronMessagePackHandler<{ jobId: string; enabled: boolean; workspaceId?: string }>(
    'cron:toggle',
    async (args) => {
      if (!args.jobId) return { error: 'jobId is required' }

      try {
        const row = await getCronJob(args.jobId, args.workspaceId ?? 'local-personal')
        if (!row) return { error: `Job "${args.jobId}" not found` }
        if ((row.workspace_id ?? 'local-personal') !== (args.workspaceId ?? 'local-personal')) {
          return { error: `Job "${args.jobId}" not found` }
        }
        if (row.deleted_at) return { error: `Job "${args.jobId}" has been deleted` }

        const now = Date.now()
        if (args.enabled) {
          const schedErr = validateSchedule({
            kind: row.schedule_kind,
            at: row.schedule_at ?? undefined,
            every: row.schedule_every ?? undefined,
            expr: row.schedule_expr ?? undefined,
            tz: row.schedule_tz
          })
          if (schedErr) return { error: schedErr }
        }
        await setCronJobEnabled(args.jobId, args.enabled, now, args.workspaceId ?? 'local-personal')

        if (args.enabled) {
          const scheduled = scheduleJob({ ...row, enabled: 1, updated_at: now })
          if (!scheduled) {
            await setCronJobEnabled(
              args.jobId,
              false,
              Date.now(),
              args.workspaceId ?? 'local-personal'
            )
            return { error: `Failed to schedule job (kind=${row.schedule_kind})` }
          }
        } else {
          cancelJob(args.jobId)
        }

        return { success: true, jobId: args.jobId, enabled: args.enabled }
      } catch (err) {
        return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  )

  registerCronMessagePackHandler<{
    jobId: string
    workspaceId?: string
    trialRun?: boolean
  }>('cron:run-now', async (args) => {
    if (!args.jobId) return { error: 'jobId is required' }

    try {
      const row = await getCronJob(args.jobId, args.workspaceId ?? 'local-personal')
      if (!row) return { error: `Job "${args.jobId}" not found` }
      if ((row.workspace_id ?? 'local-personal') !== (args.workspaceId ?? 'local-personal')) {
        return { error: `Job "${args.jobId}" not found` }
      }
      if (row.deleted_at) return { error: `Job "${args.jobId}" has been deleted` }

      const firedAt = Date.now()
      const trialRun = args.trialRun === true
      if (!markRunning(row.id)) {
        if (isCronWorkspaceSwitchPending()) return { error: 'WORKSPACE_BUSY_CRON' }
        const reason = await recordSkippedCronRun(row, firedAt)
        return { error: reason }
      }
      const firedPayload = {
        jobId: row.id,
        name: row.name,
        prompt: row.prompt,
        agentId: row.agent_id,
        model: row.model,
        sourceProviderId: row.source_provider_id,
        workingFolder: row.working_folder,
        sshConnectionId: row.ssh_connection_id,
        sessionId: row.session_id,
        firedAt,
        trialRun,
        deliveryMode: trialRun ? 'none' : row.delivery_mode,
        runKind: trialRun ? ('trial' as const) : ('manual' as const),
        deliveryTarget: trialRun ? null : row.delivery_target,
        maxIterations: row.max_iterations,
        pluginId: trialRun ? null : row.plugin_id,
        pluginChatId: trialRun ? null : row.plugin_chat_id
      }
      sendCronWorkspaceEvent(row.workspace_id ?? 'local-personal', 'cron:fired', firedPayload)

      const runOptions: CronAgentRunOptions = {
        jobId: row.id,
        name: row.name,
        sessionId: row.session_id,
        prompt: row.prompt,
        agentId: row.agent_id,
        model: row.model,
        modelSource: parseCronModelBinding(row.model_source, row.workspace_id),
        workspaceId: row.workspace_id ?? 'local-personal',
        sourceProviderId: row.source_provider_id,
        workingFolder: row.working_folder,
        sshConnectionId: row.ssh_connection_id,
        firedAt,
        deliveryMode: trialRun ? 'none' : row.delivery_mode,
        deliveryTarget: trialRun ? null : row.delivery_target,
        maxIterations: row.max_iterations,
        pluginId: trialRun ? null : row.plugin_id,
        pluginChatId: trialRun ? null : row.plugin_chat_id,
        trialRun,
        runKind: trialRun ? 'trial' : 'manual',
        getScheduledState: () => getScheduledJobIds().includes(row.id)
      }
      const finished = () => {
        void markFinished(row.id)
      }
      // “Run now” uses the same authoritative TS runtime as scheduled jobs.
      runTsCronAgentInBackground(runOptions, finished)

      return { success: true, jobId: args.jobId }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  registerCronMessagePackHandler<{ jobId: string; workspaceId: string }>(
    'cron:abort-run',
    async (args) => {
      if (!args?.jobId) return { error: 'jobId is required' }
      if (!(await getCronJob(args.jobId, args.workspaceId)))
        return { error: `Job "${args.jobId}" not found` }
      const aborted = abortTsCronAgentRun(args.jobId)
      return aborted
        ? { success: true, jobId: args.jobId }
        : { error: `Job "${args.jobId}" is not running` }
    }
  )

  registerCronMessagePackHandler<{
    jobId?: string
    sessionId?: string | null
    workspaceId?: string
    start?: number
    end?: number
    limit?: number
  }>('cron:runs', async (args) => {
    try {
      const rows = await listCronRuns(args ?? {})
      return rows.map(runToApi)
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  registerCronMessagePackHandler<CronRunCreateArgs>('cron:run:create', async (args) => {
    if (!args.runId || !args.jobId) return { error: 'runId and jobId are required' }
    try {
      if (!(await getCronJob(args.jobId, args.workspaceId)))
        return { error: `Job "${args.jobId}" not found` }
      await createCronRun(args)
      return { success: true }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  registerCronMessagePackHandler<CronRunUpdateArgs>('cron:run:update', async (args) => {
    if (!args.runId) return { error: 'runId is required' }
    try {
      if (!(await getCronRun(args.runId, args.workspaceId)))
        return { error: `Run "${args.runId}" not found` }
      if (!args.patch || Object.keys(args.patch).length === 0) return { success: true }
      await updateCronRun(args)
      return { success: true }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  registerCronMessagePackHandler<CronRunMessagesReplaceArgs>(
    'cron:run-messages:replace',
    async (args) => {
      if (!args.runId) return { error: 'runId is required' }
      try {
        if (!(await getCronRun(args.runId, args.workspaceId)))
          return { error: `Run "${args.runId}" not found` }
        await replaceCronRunMessages(args.runId, args.messages, args.workspaceId)
        return { success: true }
      } catch (err) {
        return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  )

  registerCronMessagePackHandler<CronRunLogAppendArgs>('cron:run-log:append', async (args) => {
    if (!args.runId) return { error: 'runId is required' }
    try {
      if (!(await getCronRun(args.runId, args.workspaceId)))
        return { error: `Run "${args.runId}" not found` }
      await appendCronRunLog(args.runId, args.timestamp, args.type, args.content, args.workspaceId)
      return { success: true }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  registerCronMessagePackHandler<{ runId: string; workspaceId?: string }>(
    'cron:run-detail',
    async (args) => {
      if (!args.runId) return { error: 'runId is required' }
      try {
        const detail = await getCronRunDetail(args.runId, args.workspaceId)

        const scheduledIds = new Set(getScheduledJobIds())
        const runningIds = new Set(getActiveRunJobIds())

        return {
          run: runToApi(detail.run),
          job: detail.job ? jobToApi(detail.job, scheduledIds, runningIds) : null,
          messages: detail.messages.map(
            (row): CronRunMessageApi => ({
              id: row.id,
              role: row.role,
              content: parseJsonValue(row.content),
              usage: parseJsonValue(row.usage),
              source: row.message_source,
              createdAt: row.created_at
            })
          ),
          logs: detail.logs.map(
            (row): CronRunLogApi => ({
              id: row.id,
              timestamp: row.timestamp,
              type: row.type,
              content: row.content
            })
          ),
          deliveries: detail.deliveries.map((row) => ({
            id: row.id,
            kind: row.kind,
            status: row.status,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            errorCode: row.error_code,
            retryOfId: row.retry_of_id,
            attemptNumber: row.attempt_number,
            retryAvailable:
              row.kind === 'channel' &&
              row.status === 'failed' &&
              row.attempt_number < 3 &&
              !detail.deliveries.some((attempt) => attempt.retry_of_id === row.id) &&
              Boolean(row.plugin_id && row.chat_id)
          }))
        }
      } catch (err) {
        return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  )

  registerCronMessagePackHandler<{ jobId: string; workspaceId: string }>(
    'cron:run-finished',
    async (args) => {
      if (args?.jobId && !(await getCronJob(args.jobId, args.workspaceId)))
        return { error: `Job "${args.jobId}" not found` }
      if (args?.jobId) {
        await markFinished(args.jobId)
        console.log(`[CronHandlers] Marked job ${args.jobId} as finished`)
      }
      return { success: true }
    }
  )

  registerCronMessagePackHandler<{
    runId: string
    deliveryId: string
    workspaceId: string
    outcome: 'sent' | 'failed'
  }>('cron:delivery-reconcile', async (args) => {
    if (!args.runId || !args.deliveryId || !['sent', 'failed'].includes(args.outcome))
      return { error: 'Invalid delivery reconciliation request' }
    try {
      const detail = await getCronRunDetail(args.runId, args.workspaceId)
      const delivery = detail.deliveries.find((item) => item.id === args.deliveryId)
      if (!delivery || delivery.status !== 'unknown')
        return { error: 'Cron delivery is no longer awaiting verification' }
      await reconcileCronDelivery({
        id: args.deliveryId,
        runId: args.runId,
        workspaceId: args.workspaceId,
        outcome: args.outcome,
        confirmedAt: Date.now()
      })
      return { success: true }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  registerCronMessagePackHandler<{
    runId: string
    deliveryId: string
    workspaceId: string
    content: string
  }>('cron:delivery-retry', async (args) => {
    const content = typeof args.content === 'string' ? args.content.trim() : ''
    if (!args.runId || !args.deliveryId || !content || content.length > 65_536)
      return { error: 'Invalid delivery retry request' }
    try {
      const detail = await getCronRunDetail(args.runId, args.workspaceId)
      if (detail.run.status !== 'success')
        return { error: 'Only successful Cron runs can retry delivery' }
      const parent = detail.deliveries.find((item) => item.id === args.deliveryId)
      if (!parent || parent.status !== 'failed' || parent.kind !== 'channel')
        return { error: 'Only confirmed channel delivery failures can be retried' }
      return await executeCronDeliveryRetry({
        runId: args.runId,
        workspaceId: args.workspaceId,
        retryOfId: args.deliveryId,
        content,
        createIds: () => ({
          deliveryId: `delivery-${nanoid(10)}`,
          toolCallId: `manual-retry-${nanoid(12)}`
        }),
        now: Date.now,
        prepare: async (input) =>
          await prepareCronDeliveryRetry({
            id: input.deliveryId,
            runId: input.runId,
            retryOfId: input.retryOfId,
            workspaceId: input.workspaceId,
            toolCallId: input.toolCallId,
            startedAt: input.startedAt
          }),
        send: async (attempt, message) => {
          const { executePluginAction } = await import('./channel-handlers')
          const result = await executePluginAction({
            pluginId: attempt.pluginId,
            workspaceId: args.workspaceId,
            action: 'sendMessage',
            params: { chatId: attempt.chatId, content: message }
          })
          return classifyCronDeliveryResult(result)
        },
        record: async (input) => {
          await recordCronDelivery({
            runId: input.runId,
            workspaceId: input.workspaceId,
            toolCallId: input.toolCallId,
            kind: 'channel',
            status: input.status,
            startedAt: input.startedAt,
            finishedAt: input.finishedAt,
            errorCode: input.errorCode,
            retryOfId: input.retryOfId,
            attemptNumber: input.attempt.attemptNumber,
            pluginId: input.attempt.pluginId,
            chatId: input.attempt.chatId
          })
        }
      })
    } catch (err) {
      return {
        error: `Could not prepare delivery retry: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  })
}
