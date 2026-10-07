import { nanoid } from 'nanoid'
import { desktopRuntime } from '../runtime/desktop-runtime'
import { sendCronWorkspaceEvent } from './cron-workspace-events'
import { deliverCronSessionResult } from './cron-session-delivery'
import { classifyCronDeliveryResult } from './cron-delivery-tracking'
import {
  appendCronRunLog,
  createCronRun,
  getCronJob,
  getCronRun,
  recordCronDelivery,
  replaceCronRunMessages,
  updateCronRun,
  type CronRunLogType,
  type CronRunStatus
} from '../db/cron-dao'
import { businessWriteCanary } from '../db/business-write-canary'
import {
  TERMINAL_STATUSES,
  type RunEvent,
  type RunSnapshot,
  type RunSpec
} from '../../shared/runtime/contracts'
import type { CronAgentRunOptions, AgentDefinition } from './cron-runtime-types'
import { resolveCronAgentDefinition } from './cron-agent-definition'

const CRON_SYSTEM_PROMPT =
  'You are CronAgent, a scheduled task assistant. You execute tasks autonomously on a timer. ' +
  'Be concise and action-oriented. Complete the task, then deliver results as instructed.'
const POLL_INTERVAL_MS = 250

type ActiveTsCronRun = { controller: AbortController; runId?: string; workspaceId: string }
type TsExecutionState = {
  startedAt: number
  progress: { iteration: number; toolCalls: number; currentStep?: string }
}

const activeRuns = new Map<string, ActiveTsCronRun>()
const executionState = new Map<string, TsExecutionState>()

function cronStatus(status: string): CronRunStatus {
  if (status === 'completed') return 'success'
  if (status === 'cancelled') return 'aborted'
  return 'error'
}

function eventText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function eventObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function appendLog(
  options: CronAgentRunOptions,
  runId: string,
  type: CronRunLogType,
  content: string
): Promise<void> {
  const timestamp = Date.now()
  await appendCronRunLog(runId, timestamp, type, content, resolveWorkspaceId(options))
  sendCronWorkspaceEvent(resolveWorkspaceId(options), 'cron:run-log-appended', {
    jobId: options.jobId,
    timestamp,
    type,
    content
  })
}

function setProgress(
  options: CronAgentRunOptions,
  runId: string,
  startedAt: number,
  progress: TsExecutionState['progress']
): void {
  executionState.set(options.jobId, { startedAt, progress })
  sendCronWorkspaceEvent(resolveWorkspaceId(options), 'cron:run-progress', {
    jobId: options.jobId,
    runId,
    ...progress,
    elapsed: Date.now() - startedAt
  })
}

function cronPrompt(options: CronAgentRunOptions, definition: AgentDefinition): string {
  if (options.trialRun) {
    return `${definition.systemPrompt}\n\nYou are performing a Cron trial run for task (ID: ${options.jobId}).\n\n## Trial Run Rules\nDo not change files, run commands, connect to external services, or send messages or notifications. Inspect only the explicitly selected workspace using read-only tools. Explain what you could verify, what would be changed or executed during a real run, and any missing requirements. Do not claim that the scheduled task was completed.\n\n## Task Preview\n${options.prompt}\n\nReturn a concise preview in the language of the task. This is a trial run; do not deliver the result externally.`
  }
  const channelInfo = options.deliveryTarget ? `\nTarget session: ${options.deliveryTarget}` : ''
  const channelDelivery =
    options.deliveryMode !== 'session' &&
    options.deliveryMode !== 'none' &&
    options.pluginId &&
    options.pluginChatId
      ? `When finished, call PluginSendMessage exactly once with plugin_id="${options.pluginId}" and chat_id="${options.pluginChatId}". Send only the concise result summary, then stop.`
      : null
  const delivery = channelDelivery
    ? channelDelivery
    : options.deliveryMode === 'session'
      ? 'Give the final result in your response. The application will save it to the target session; do not call Notify.'
      : options.deliveryMode === 'none'
        ? 'Do not send a desktop notification. Give the final result in your response.'
        : 'When finished, call Notify exactly once with a concise, friendly desktop result summary.'
  return `${definition.systemPrompt}\n\nYou are a scheduled task assistant running cron job (ID: ${options.jobId}).${channelInfo}\n\n## Your Task\n${options.prompt}\n\n## Delivery Instructions\n${delivery}\n\nMatch the language of the task prompt in your delivery message (Chinese task → Chinese reply, English task → English reply). Be concise and friendly.\n\nBegin working on this task now.`
}

const TS_CRON_WORKSPACE_TOOL_NAMES = new Set([
  'Read',
  'Write',
  'Edit',
  'LS',
  'Glob',
  'Grep',
  'Bash'
])

function toolNames(options: CronAgentRunOptions, definition: AgentDefinition): string[] {
  const allowed = new Set(definition.allowedTools)
  if (options.trialRun) {
    return ['Read', 'LS', 'Glob', 'Grep'].filter((name) => allowed.has(name))
  }
  const names =
    options.deliveryMode !== 'session' &&
    options.deliveryMode !== 'none' &&
    options.pluginId &&
    options.pluginChatId
      ? allowed.has('PluginSendMessage')
        ? ['PluginSendMessage']
        : []
      : options.deliveryMode === 'none' || options.deliveryMode === 'session'
        ? []
        : allowed.has('Notify')
          ? ['Notify']
          : []
  if (options.workingFolder || options.sshConnectionId) {
    for (const name of definition.allowedTools) {
      if (TS_CRON_WORKSPACE_TOOL_NAMES.has(name) && !names.includes(name)) names.push(name)
    }
  }
  return names
}

/**
 * A local provider can be selected in every workspace, but the run still owns
 * the job's data workspace. Hosted bindings additionally carry an authorization
 * workspace and must agree with that job scope.
 */
function resolveWorkspaceId(options: CronAgentRunOptions): string {
  if (!options.modelSource) throw new Error('MODEL_NOT_SELECTED')
  const workspaceId =
    options.workspaceId?.trim() ||
    (options.modelSource.kind === 'local' ? 'local-personal' : options.modelSource.workspaceId)
  if (options.modelSource.kind !== 'local' && options.modelSource.workspaceId !== workspaceId)
    throw new Error('WORKSPACE_MISMATCH')
  return workspaceId
}

/** Creates an explicit, credential-free runtime request from a persisted Cron binding. */
export function createTsCronRunSpec(
  options: CronAgentRunOptions,
  runId: string,
  agentDefinition?: AgentDefinition
): RunSpec {
  if (!options.modelSource) throw new Error('MODEL_NOT_SELECTED')
  const workspaceId = resolveWorkspaceId(options)
  const definition: AgentDefinition = agentDefinition ?? {
    name: 'CronAgent',
    description: 'Scheduled task agent for cron jobs',
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'LS',
      'Glob',
      'Grep',
      'Bash',
      'Notify',
      'PluginSendMessage'
    ],
    maxIterations: 15,
    systemPrompt: CRON_SYSTEM_PROMPT
  }
  return {
    runId,
    taskId: `cron:${options.jobId}`,
    requestId: runId,
    traceId: runId,
    sessionId: options.sessionId ?? options.jobId,
    workspaceId,
    environmentId: 'local',
    ...(options.workingFolder ? { workingDirectory: options.workingFolder } : {}),
    ...(options.sshConnectionId ? { sshConnectionId: options.sshConnectionId } : {}),
    ...(!options.trialRun &&
    options.deliveryMode !== 'session' &&
    options.deliveryMode !== 'none' &&
    options.pluginId &&
    options.pluginChatId
      ? { channelContext: { pluginId: options.pluginId, chatId: options.pluginChatId } }
      : {}),
    toolNames: toolNames(options, definition),
    maxTurns: Math.max(1, Math.min(options.maxIterations ?? definition.maxIterations, 128)),
    modelSource: options.modelSource,
    modelOptions: {
      systemPrompt: definition.systemPrompt,
      ...(definition.temperature !== undefined ? { temperature: definition.temperature } : {})
    },
    prompt: cronPrompt(options, definition),
    unattended: true
  }
}

function toRunPayload(run: NonNullable<Awaited<ReturnType<typeof getCronRun>>>) {
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
    deliveryTargetSnapshot: run.delivery_target_snapshot,
    deliveryStatus: run.delivery_status ?? null
  }
}

async function emitFinished(
  options: CronAgentRunOptions,
  runId: string,
  status: CronRunStatus,
  toolCallCount: number,
  outputSummary: string,
  error?: string
): Promise<void> {
  const workspaceId = resolveWorkspaceId(options)
  if (!options.trialRun && options.deliveryMode === 'session') {
    try {
      await deliverCronSessionResult({
        runId,
        workspaceId,
        targetSessionId: options.deliveryTarget || options.sessionId || null,
        content: outputSummary || error || 'Scheduled task finished without output.'
      })
    } catch (deliveryError) {
      console.error('[CronDelivery] Failed to persist session delivery:', deliveryError)
    }
  }
  const [run, job] = await Promise.all([
    getCronRun(runId, workspaceId),
    getCronJob(options.jobId, workspaceId)
  ])
  sendCronWorkspaceEvent(workspaceId, 'cron:run-finished', {
    jobId: options.jobId,
    runId,
    status,
    toolCallCount,
    jobName: options.name,
    sessionId: options.sessionId ?? null,
    deliveryMode: options.deliveryMode ?? 'desktop',
    deliveryTarget: options.deliveryTarget ?? null,
    outputSummary,
    scheduled: options.getScheduledState?.() ?? false,
    ...(error ? { error } : {}),
    ...(run ? { run: toRunPayload(run) } : {}),
    ...(job
      ? {
          job: {
            id: job.id,
            name: job.name,
            sessionId: job.session_id,
            executing: false,
            executionStartedAt: null,
            executionProgress: null
          }
        }
      : {})
  })
}

async function projectEvent(
  event: RunEvent,
  state: { output: string; toolCalls: number; iteration: number; error?: string },
  options: CronAgentRunOptions,
  runId: string,
  startedAt: number
): Promise<void> {
  const data = eventObject(event.data)
  if (event.type === 'run.status') {
    if (data.status === 'failed' && typeof data.reason === 'string') state.error = data.reason
  } else if (event.type === 'turn.started') {
    state.iteration = typeof data.turn === 'number' ? data.turn + 1 : state.iteration + 1
    setProgress(options, runId, startedAt, {
      iteration: state.iteration,
      toolCalls: state.toolCalls,
      currentStep: 'thinking'
    })
  } else if (event.type === 'message.delta') {
    if (typeof data.text === 'string') state.output += data.text
  } else if (event.type === 'tool.generated') {
    const name = typeof data.name === 'string' ? data.name : 'tool'
    if ((name === 'Notify' || name === 'PluginSendMessage') && typeof data.id === 'string') {
      await recordCronDelivery({
        runId,
        workspaceId: resolveWorkspaceId(options),
        toolCallId: data.id,
        kind: name === 'Notify' ? 'desktop' : 'channel',
        status: 'pending',
        startedAt: event.timestamp
      }).catch((error) => console.error('[CronDelivery] Failed to record pending delivery', error))
    }
    await appendLog(options, runId, 'tool_call', `${name}(${eventText(data.input)})`)
    setProgress(options, runId, startedAt, {
      iteration: state.iteration,
      toolCalls: state.toolCalls,
      currentStep: name
    })
  } else if (event.type === 'tool.result') {
    state.toolCalls += 1
    const name = typeof data.name === 'string' ? data.name : 'tool'
    if ((name === 'Notify' || name === 'PluginSendMessage') && typeof data.id === 'string') {
      const output = eventObject(data.output)
      const deliveryStatus = data.isError === true ? 'unknown' : classifyCronDeliveryResult(output)
      await recordCronDelivery({
        runId,
        workspaceId: resolveWorkspaceId(options),
        toolCallId: data.id,
        kind: name === 'Notify' ? 'desktop' : 'channel',
        status: deliveryStatus,
        startedAt: event.timestamp,
        finishedAt: event.timestamp,
        errorCode:
          deliveryStatus === 'failed'
            ? 'TOOL_DELIVERY_FAILED'
            : data.isError === true
              ? 'TOOL_RESULT_AMBIGUOUS'
              : null
      }).catch((error) => console.error('[CronDelivery] Failed to record delivery result', error))
    }
    await appendLog(
      options,
      runId,
      'tool_result',
      `${name}: ${eventText(data.output).slice(0, 300)}`
    )
    setProgress(options, runId, startedAt, {
      iteration: state.iteration,
      toolCalls: state.toolCalls,
      currentStep: name
    })
  }
}

async function runInternal(options: CronAgentRunOptions, active: ActiveTsCronRun): Promise<void> {
  if (!options.modelSource) throw new Error('MODEL_NOT_SELECTED')
  const runId = `run-${nanoid(8)}`
  const agentDefinition = await resolveCronAgentDefinition(options.agentId)
  const workspaceId = resolveWorkspaceId(options)
  active.runId = runId
  active.workspaceId = workspaceId
  const startedAt = Date.now()
  const state: { output: string; toolCalls: number; iteration: number; error?: string } = {
    output: '',
    toolCalls: 0,
    iteration: 0
  }
  const deliveryMode: 'desktop' | 'session' | 'none' =
    options.deliveryMode === 'session' || options.deliveryMode === 'none'
      ? options.deliveryMode
      : 'desktop'
  const runKind = options.runKind ?? (options.trialRun ? 'trial' : 'scheduled')
  const scheduledFor = runKind === 'scheduled' ? (options.firedAt ?? null) : null
  const writer = businessWriteCanary()
  if (writer) {
    const started = await writer.startCronRun({
      id: runId,
      jobId: options.jobId,
      workspaceId,
      startedAt,
      scheduledFor,
      jobNameSnapshot: options.name ?? null,
      promptSnapshot: options.prompt,
      sourceSessionIdSnapshot: options.sessionId ?? null,
      modelSnapshot: options.model ?? null,
      modelSourceSnapshot: JSON.stringify(options.modelSource),
      workingFolderSnapshot: options.workingFolder ?? null,
      deliveryModeSnapshot: deliveryMode,
      runKind,
      deliveryTargetSnapshot: options.deliveryTarget ?? null,
      firedAt: options.firedAt ?? startedAt
    })
    if (!started.started) throw new Error(`CRON_RUN_NOT_STARTED:${started.reason ?? 'unknown'}`)
  } else {
    await createCronRun({
      runId,
      jobId: options.jobId,
      workspaceId,
      startedAt,
      scheduledFor,
      jobNameSnapshot: options.name ?? null,
      promptSnapshot: options.prompt,
      sourceSessionIdSnapshot: options.sessionId ?? null,
      modelSnapshot: options.model ?? null,
      modelSourceSnapshot: JSON.stringify(options.modelSource),
      workingFolderSnapshot: options.workingFolder ?? null,
      deliveryModeSnapshot: deliveryMode,
      runKind,
      deliveryTargetSnapshot: options.deliveryTarget ?? null
    })
  }
  sendCronWorkspaceEvent(workspaceId, 'cron:run-started', {
    jobId: options.jobId,
    runId
  })
  setProgress(options, runId, startedAt, {
    iteration: 0,
    toolCalls: 0,
    currentStep: 'initializing'
  })
  await appendLog(options, runId, 'start', options.prompt.slice(0, 400))
  try {
    await desktopRuntime.request('run.submit', createTsCronRunSpec(options, runId, agentDefinition))
    let afterSeq = 0
    let snapshot: RunSnapshot | null = null
    let cancellationRequested = false
    for (;;) {
      snapshot = await desktopRuntime.request<RunSnapshot | null>('run.snapshot', {
        runId,
        workspaceId,
        afterSeq
      })
      if (!snapshot) throw new Error('RUN_NOT_FOUND')
      for (const event of snapshot.events) {
        afterSeq = Math.max(afterSeq, event.seq)
        await projectEvent(event, state, options, runId, startedAt)
      }
      if (TERMINAL_STATUSES.has(snapshot.run.status) && afterSeq >= snapshot.run.seq) break
      if (active.controller.signal.aborted && !cancellationRequested) {
        cancellationRequested = true
        await desktopRuntime.request('run.cancel', { runId, workspaceId }).catch(() => undefined)
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    const finalStatus = snapshot.run.status
    const status = cronStatus(finalStatus)
    const error =
      finalStatus === 'failed' ? (state.error ?? 'TS runtime execution failed') : undefined
    const outputSummary = state.output.slice(0, 2_000)
    await replaceCronRunMessages(
      runId,
      [
        { id: nanoid(), role: 'user', content: options.prompt, createdAt: startedAt },
        ...(state.output
          ? [{ id: nanoid(), role: 'assistant', content: state.output, createdAt: Date.now() }]
          : [])
      ],
      workspaceId
    )
    await appendLog(options, runId, 'end', status)
    await updateCronRun({
      runId,
      workspaceId,
      patch: {
        finishedAt: Date.now(),
        status,
        toolCallCount: state.toolCalls,
        outputSummary: outputSummary || null,
        error: error ?? null
      }
    })
    await emitFinished(options, runId, status, state.toolCalls, outputSummary, error)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendLog(options, runId, 'error', message).catch(() => undefined)
    await appendLog(options, runId, 'end', 'error').catch(() => undefined)
    await updateCronRun({
      runId,
      workspaceId,
      patch: {
        finishedAt: Date.now(),
        status: active.controller.signal.aborted ? 'aborted' : 'error',
        toolCallCount: state.toolCalls,
        outputSummary: state.output.slice(0, 2_000) || null,
        error: message
      }
    }).catch(() => undefined)
    await emitFinished(
      options,
      runId,
      active.controller.signal.aborted ? 'aborted' : 'error',
      state.toolCalls,
      state.output.slice(0, 2_000),
      message
    ).catch(() => undefined)
  }
}

export function runTsCronAgentInBackground(
  options: CronAgentRunOptions,
  onFinished?: (jobId: string) => void
): void {
  if (activeRuns.has(options.jobId)) return
  const active: ActiveTsCronRun = {
    controller: new AbortController(),
    workspaceId:
      options.workspaceId?.trim() ??
      (options.modelSource?.kind === 'local'
        ? 'local-personal'
        : (options.modelSource?.workspaceId ?? 'local-personal'))
  }
  activeRuns.set(options.jobId, active)
  executionState.set(options.jobId, {
    startedAt: Date.now(),
    progress: { iteration: 0, toolCalls: 0, currentStep: 'initializing' }
  })
  void runInternal(options, active).finally(() => {
    activeRuns.delete(options.jobId)
    executionState.delete(options.jobId)
    onFinished?.(options.jobId)
  })
}

export function abortTsCronAgentRun(jobId: string): boolean {
  const active = activeRuns.get(jobId)
  if (!active) return false
  active.controller.abort()
  return true
}

export function getTsCronExecutionState(jobId: string): TsExecutionState | null {
  return executionState.get(jobId) ?? null
}
