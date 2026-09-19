import cron from 'node-cron'
import { nanoid } from 'nanoid'
import { sendCronWorkspaceEvent } from './cron-workspace-events'
import {
  createCronRun,
  getCronRun,
  loadPersistedCronJobs,
  markCronJobFired,
  softDeleteCronJob,
  updateCronRun,
  type CronJobRecord,
  type CronRunRecord
} from '../db/cron-dao'
import { runCronAgentInBackground } from './cron-agent-background'
import { runTsCronAgentInBackground } from './ts-cron-agent-background'
import { canRunCronInTsRuntime } from './ts-cron-selection'
import { desktopRuntime } from '../runtime/desktop-runtime'
import { parseCronModelBinding } from '../../shared/runtime/cron-model-binding'
import { quiesceCronWritesForHandover } from './cron-write-gate'

export type { CronJobRecord, CronRunRecord }

// ── Scheduled Handle (unified abstraction) ───────────────────────

interface ScheduledHandle {
  stop(): void
}

const scheduledHandles = new Map<string, ScheduledHandle>()

// ── Concurrency ──────────────────────────────────────────────────

let maxConcurrentRuns = 2
const activeRunJobIds = new Set<string>()
const finishingRuns = new Set<Promise<void>>()
let quiescingForHandover = false
let workspaceSwitchPending = false
/** Jobs with delete_after_run that are waiting for the agent run to finish before DB deletion */
const pendingDeleteAfterRun = new Map<string, string>()

export function setMaxConcurrentRuns(n: number): void {
  maxConcurrentRuns = Math.max(1, n)
}

export function isRunning(jobId: string): boolean {
  return activeRunJobIds.has(jobId)
}

export function markRunning(jobId: string): boolean {
  if (quiescingForHandover || workspaceSwitchPending) return false
  if (activeRunJobIds.has(jobId)) return false
  if (activeRunJobIds.size >= maxConcurrentRuns) {
    console.warn(
      `[CronScheduler] Concurrency limit reached (${maxConcurrentRuns}), skipping job ${jobId}`
    )
    return false
  }
  activeRunJobIds.add(jobId)
  return true
}

function getSkipReason(jobId: string): string {
  if (activeRunJobIds.has(jobId)) return 'Skipped: this job is already running'
  return `Skipped: cron concurrency limit (${maxConcurrentRuns}) reached`
}

function toRunApi(run: CronRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    jobId: run.job_id,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    status: run.status,
    toolCallCount: run.tool_call_count,
    outputSummary: run.output_summary,
    error: run.error,
    scheduledFor: run.scheduled_for,
    jobNameSnapshot: run.job_name_snapshot,
    promptSnapshot: run.prompt_snapshot,
    sourceSessionIdSnapshot: run.source_session_id_snapshot,
    sourceSessionTitleSnapshot: run.source_session_title_snapshot,
    sourceProjectIdSnapshot: run.source_project_id_snapshot,
    sourceProjectNameSnapshot: run.source_project_name_snapshot,
    sourceProviderIdSnapshot: run.source_provider_id_snapshot,
    modelSnapshot: run.model_snapshot,
    modelSourceSnapshot: run.model_source_snapshot,
    workingFolderSnapshot: run.working_folder_snapshot,
    deliveryModeSnapshot: run.delivery_mode_snapshot,
    deliveryTargetSnapshot: run.delivery_target_snapshot
  }
}

export async function recordSkippedCronRun(
  job: CronJobRecord,
  scheduledFor = Date.now()
): Promise<string> {
  if (quiescingForHandover) throw new Error('CRON_SCHEDULER_QUIESCING')
  if (workspaceSwitchPending) throw new Error('WORKSPACE_BUSY_CRON')
  const reason = getSkipReason(job.id)

  try {
    const runId = `run-${nanoid(8)}`
    await createCronRun({
      runId,
      jobId: job.id,
      workspaceId: job.workspace_id ?? 'local-personal',
      startedAt: scheduledFor,
      scheduledFor,
      jobNameSnapshot: job.name,
      promptSnapshot: job.prompt,
      sourceSessionIdSnapshot: job.session_id,
      sourceSessionTitleSnapshot: job.source_session_title,
      sourceProjectIdSnapshot: job.source_project_id,
      sourceProjectNameSnapshot: job.source_project_name,
      sourceProviderIdSnapshot: job.source_provider_id,
      modelSnapshot: job.model,
      modelSourceSnapshot: job.model_source,
      workingFolderSnapshot: job.working_folder,
      deliveryModeSnapshot: job.delivery_mode,
      deliveryTargetSnapshot: job.delivery_target
    })
    await updateCronRun({
      runId,
      workspaceId: job.workspace_id ?? 'local-personal',
      patch: {
        finishedAt: Date.now(),
        status: 'skipped',
        toolCallCount: 0,
        outputSummary: null,
        error: reason
      }
    })
    const run = await getCronRun(runId, job.workspace_id ?? 'local-personal')
    sendCronWorkspaceEvent(job.workspace_id ?? 'local-personal', 'cron:run-finished', {
      jobId: job.id,
      runId,
      status: 'skipped',
      toolCallCount: 0,
      jobName: job.name,
      sessionId: job.session_id,
      deliveryMode: job.delivery_mode,
      deliveryTarget: job.delivery_target,
      error: reason,
      ...(run ? { run: toRunApi(run) } : {})
    })
  } catch (err) {
    console.error(`[CronScheduler] Failed to persist skipped run for ${job.id}:`, err)
  }

  return reason
}

export async function markFinished(jobId: string): Promise<void> {
  const finishing = (async () => {
    // Deferred delete_after_run remains a legacy DB write until it settles.
    const workspaceId = pendingDeleteAfterRun.get(jobId)
    if (workspaceId) {
      pendingDeleteAfterRun.delete(jobId)
      try {
        const now = Date.now()
        await softDeleteCronJob(jobId, now, workspaceId)
        sendToRenderer(workspaceId, 'cron:job-removed', { jobId, reason: 'delete_after_run' })
        console.log(`[CronScheduler] Deferred delete_after_run: soft-deleted job ${jobId}`)
      } catch (err) {
        console.error(`[CronScheduler] Failed to soft-delete job ${jobId} after run:`, err)
      }
    }
  })()
  finishingRuns.add(finishing)
  try {
    await finishing
  } finally {
    finishingRuns.delete(finishing)
    activeRunJobIds.delete(jobId)
  }
}

// ── Renderer communication ───────────────────────────────────────

function sendToRenderer(workspaceId: string, channel: string, data: Record<string, unknown>): void {
  sendCronWorkspaceEvent(workspaceId, channel, data)
}

// ── Job fired handler ────────────────────────────────────────────

async function onJobFired(job: CronJobRecord): Promise<void> {
  if (quiescingForHandover || workspaceSwitchPending) return
  const firedAt = Date.now()

  // Concurrency guard — prevent firing if this job is already running or limit reached
  if (!markRunning(job.id)) {
    const reason = await recordSkippedCronRun(job, firedAt)
    console.warn(`[CronScheduler] Job ${job.id} ${reason}`)
    return
  }

  try {
    // Forward to renderer for UI updates only.
    sendToRenderer(job.workspace_id ?? 'local-personal', 'cron:fired', {
      jobId: job.id,
      name: job.name,
      prompt: job.prompt,
      agentId: job.agent_id,
      model: job.model,
      sourceProviderId: job.source_provider_id,
      workingFolder: job.working_folder,
      sshConnectionId: job.ssh_connection_id,
      sessionId: job.session_id,
      firedAt,
      deliveryMode: job.delivery_mode,
      deliveryTarget: job.delivery_target,
      maxIterations: job.max_iterations,
      pluginId: job.plugin_id,
      pluginChatId: job.plugin_chat_id
    })

    let modelSource
    try {
      modelSource = parseCronModelBinding(job.model_source, job.workspace_id)
    } catch (error) {
      throw new Error(
        `Cron model binding is invalid: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const runOptions = {
      jobId: job.id,
      name: job.name,
      sessionId: job.session_id,
      prompt: job.prompt,
      agentId: job.agent_id,
      model: job.model,
      modelSource,
      workspaceId: job.workspace_id ?? 'local-personal',
      sourceProviderId: job.source_provider_id,
      workingFolder: job.working_folder,
      sshConnectionId: job.ssh_connection_id,
      firedAt,
      deliveryMode: job.delivery_mode,
      deliveryTarget: job.delivery_target,
      maxIterations: job.max_iterations,
      pluginId: job.plugin_id,
      pluginChatId: job.plugin_chat_id,
      getScheduledState: () => scheduledHandles.has(job.id)
    }
    const finished = () => {
      void markFinished(job.id)
    }
    const useTsRuntime = canRunCronInTsRuntime(runOptions, desktopRuntime.isAvailable)
    // TS cron atomically creates the run snapshot and advances fire_count. Native
    // keeps the legacy two-step path until its runtime is retired.
    if (!useTsRuntime) {
      await markCronJobFired(job.id, firedAt, job.workspace_id ?? 'local-personal')
    }
    if (useTsRuntime) {
      runTsCronAgentInBackground(runOptions, finished)
    } else {
      runCronAgentInBackground(runOptions, finished)
    }

    // Handle delete_after_run: stop the schedule handle now (prevent re-fire),
    // but defer DB deletion + UI removal until the agent run finishes (cron:run-finished).
    // This keeps the job visible in the UI during execution.
    if (job.delete_after_run) {
      const handle = scheduledHandles.get(job.id)
      if (handle) {
        handle.stop()
        scheduledHandles.delete(job.id)
      }
      pendingDeleteAfterRun.set(job.id, job.workspace_id ?? 'local-personal')
    }
  } catch (err) {
    console.error('[CronScheduler] Job fire error:', err)
    await markFinished(job.id)
    sendToRenderer(job.workspace_id ?? 'local-personal', 'cron:fired', {
      jobId: job.id,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

// ── Schedule a job ───────────────────────────────────────────────

export function scheduleJob(record: CronJobRecord): boolean {
  if (quiescingForHandover) return false
  // Stop any existing handle
  const existing = scheduledHandles.get(record.id)
  if (existing) {
    existing.stop()
    scheduledHandles.delete(record.id)
  }

  const kind = record.schedule_kind

  if (kind === 'at') {
    const targetMs = record.schedule_at
    if (!targetMs) return false
    const delay = targetMs - Date.now()
    if (delay <= -30_000) {
      // More than 30s in the past — skip instead of firing immediately
      console.warn(`[CronScheduler] Job ${record.id} schedule_at is in the past, skipping`)
      return false
    }
    if (delay <= 0) {
      // Within 30s tolerance — fire immediately (e.g. app just started)
      void onJobFired(record)
      return true
    }
    const timer = setTimeout(() => {
      scheduledHandles.delete(record.id)
      void onJobFired(record)
    }, delay)
    scheduledHandles.set(record.id, { stop: () => clearTimeout(timer) })
    return true
  }

  if (kind === 'every') {
    const intervalMs = record.schedule_every
    if (!intervalMs || intervalMs < 1000) return false

    const anchor = record.last_fired_at ?? record.updated_at ?? record.created_at
    const now = Date.now()
    const elapsed = Math.max(0, now - anchor)
    const initialDelay = intervalMs - (elapsed % intervalMs || intervalMs)

    let interval: NodeJS.Timeout | null = null
    const timeout = setTimeout(() => {
      void onJobFired(record)
      interval = setInterval(() => {
        void onJobFired(record)
      }, intervalMs)
    }, initialDelay)

    scheduledHandles.set(record.id, {
      stop: () => {
        clearTimeout(timeout)
        if (interval) clearInterval(interval)
      }
    })
    return true
  }

  if (kind === 'cron') {
    const expr = record.schedule_expr
    if (!expr || !cron.validate(expr)) return false
    const task = cron.schedule(
      expr,
      () => {
        void onJobFired(record)
      },
      { timezone: record.schedule_tz || 'UTC' }
    )
    scheduledHandles.set(record.id, { stop: () => task.stop() })
    return true
  }

  return false
}

// ── Cancel / unschedule ──────────────────────────────────────────

export function cancelJob(id: string): boolean {
  const handle = scheduledHandles.get(id)
  if (!handle) return false
  handle.stop()
  scheduledHandles.delete(id)
  return true
}

// ── Load persisted jobs on startup ───────────────────────────────

export async function loadPersistedJobs(): Promise<void> {
  try {
    const rows = await loadPersistedCronJobs()
    let loaded = 0
    for (const row of rows) {
      if (scheduleJob(row)) {
        loaded++
      } else {
        console.warn('[CronScheduler] Failed to schedule job', row.id, row.schedule_kind)
      }
    }
    console.log(`[CronScheduler] Loaded ${loaded}/${rows.length} persisted cron jobs`)
  } catch (err) {
    console.error('[CronScheduler] Failed to load persisted jobs:', err)
  }
}

// ── Cancel all (shutdown) ────────────────────────────────────────

export function cancelAllJobs(): void {
  for (const [, handle] of scheduledHandles) {
    handle.stop()
  }
  scheduledHandles.clear()
}

/** Stops future fires and refuses a handover while a legacy run can still write. */
export function quiesceCronSchedulerForHandover(): void {
  quiescingForHandover = true
  for (const handle of scheduledHandles.values()) handle.stop()
  scheduledHandles.clear()
  if (activeRunJobIds.size > 0 || finishingRuns.size > 0)
    throw new Error('CRON_RUNS_ACTIVE_DURING_HANDOVER')
  quiesceCronWritesForHandover()
}

// ── Query helpers ────────────────────────────────────────────────

export function getScheduledJobIds(): string[] {
  return Array.from(scheduledHandles.keys())
}

export function getActiveRunJobIds(): string[] {
  return Array.from(activeRunJobIds)
}

export function hasActiveOrFinishingCronRuns(): boolean {
  return activeRunJobIds.size > 0 || finishingRuns.size > 0
}

/** Blocks new Cron runs while Main checks and switches the active workspace. */
export function beginCronWorkspaceSwitch(): () => void {
  if (workspaceSwitchPending || hasActiveOrFinishingCronRuns())
    throw new Error('WORKSPACE_BUSY_CRON')
  workspaceSwitchPending = true
  let released = false
  return () => {
    if (released) return
    released = true
    workspaceSwitchPending = false
  }
}

export function isCronWorkspaceSwitchPending(): boolean {
  return workspaceSwitchPending
}
