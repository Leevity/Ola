import cron from 'node-cron'
import { nanoid } from 'nanoid'
import { BrowserWindow } from 'electron'
import { safeSendMessagePackToAllWindows, safeSendMessagePackToWindow } from '../window-ipc'
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

export type { CronJobRecord, CronRunRecord }

// ── Scheduled Handle (unified abstraction) ───────────────────────

interface ScheduledHandle {
  stop(): void
}

const scheduledHandles = new Map<string, ScheduledHandle>()

// ── Concurrency ──────────────────────────────────────────────────

let maxConcurrentRuns = 2
const activeRunJobIds = new Set<string>()
/** Jobs with delete_after_run that are waiting for the agent run to finish before DB deletion */
const pendingDeleteAfterRun = new Set<string>()

export function setMaxConcurrentRuns(n: number): void {
  maxConcurrentRuns = Math.max(1, n)
}

export function isRunning(jobId: string): boolean {
  return activeRunJobIds.has(jobId)
}

export function markRunning(jobId: string): boolean {
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
    workingFolderSnapshot: run.working_folder_snapshot,
    deliveryModeSnapshot: run.delivery_mode_snapshot,
    deliveryTargetSnapshot: run.delivery_target_snapshot
  }
}

export async function recordSkippedCronRun(
  job: CronJobRecord,
  scheduledFor = Date.now()
): Promise<string> {
  const reason = getSkipReason(job.id)

  try {
    const runId = `run-${nanoid(8)}`
    await createCronRun({
      runId,
      jobId: job.id,
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
      workingFolderSnapshot: job.working_folder,
      deliveryModeSnapshot: job.delivery_mode,
      deliveryTargetSnapshot: job.delivery_target
    })
    await updateCronRun({
      runId,
      patch: {
        finishedAt: Date.now(),
        status: 'skipped',
        toolCallCount: 0,
        outputSummary: null,
        error: reason
      }
    })
    const run = await getCronRun(runId)
    safeSendMessagePackToAllWindows('cron:run-finished', {
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
  activeRunJobIds.delete(jobId)

  // Deferred delete_after_run: now that the agent run is done, soft-delete the job
  if (pendingDeleteAfterRun.has(jobId)) {
    pendingDeleteAfterRun.delete(jobId)
    try {
      const now = Date.now()
      await softDeleteCronJob(jobId, now)
      sendToRenderer('cron:job-removed', { jobId, reason: 'delete_after_run' })
      console.log(`[CronScheduler] Deferred delete_after_run: soft-deleted job ${jobId}`)
    } catch (err) {
      console.error(`[CronScheduler] Failed to soft-delete job ${jobId} after run:`, err)
    }
  }
}

// ── Renderer communication ───────────────────────────────────────

function sendToRenderer(channel: string, data: unknown): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    safeSendMessagePackToWindow(win, channel, data)
  }
}

// ── Job fired handler ────────────────────────────────────────────

async function onJobFired(job: CronJobRecord): Promise<void> {
  const firedAt = Date.now()

  // Concurrency guard — prevent firing if this job is already running or limit reached
  if (!markRunning(job.id)) {
    const reason = await recordSkippedCronRun(job, firedAt)
    console.warn(`[CronScheduler] Job ${job.id} ${reason}`)
    return
  }

  try {
    await markCronJobFired(job.id, firedAt)

    // Forward to renderer for UI updates only.
    sendToRenderer('cron:fired', {
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

    runCronAgentInBackground(
      {
        jobId: job.id,
        name: job.name,
        sessionId: job.session_id,
        prompt: job.prompt,
        agentId: job.agent_id,
        model: job.model,
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
      },
      () => {
        void markFinished(job.id)
      }
    )

    // Handle delete_after_run: stop the schedule handle now (prevent re-fire),
    // but defer DB deletion + UI removal until the agent run finishes (cron:run-finished).
    // This keeps the job visible in the UI during execution.
    if (job.delete_after_run) {
      const handle = scheduledHandles.get(job.id)
      if (handle) {
        handle.stop()
        scheduledHandles.delete(job.id)
      }
      pendingDeleteAfterRun.add(job.id)
    }
  } catch (err) {
    console.error('[CronScheduler] Job fire error:', err)
    await markFinished(job.id)
    sendToRenderer('cron:fired', {
      jobId: job.id,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

// ── Schedule a job ───────────────────────────────────────────────

export function scheduleJob(record: CronJobRecord): boolean {
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
      { scheduled: true, timezone: record.schedule_tz || 'UTC' }
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
  activeRunJobIds.clear()
  pendingDeleteAfterRun.clear()
}

// ── Query helpers ────────────────────────────────────────────────

export function getScheduledJobIds(): string[] {
  return Array.from(scheduledHandles.keys())
}

export function getActiveRunJobIds(): string[] {
  return Array.from(activeRunJobIds)
}
