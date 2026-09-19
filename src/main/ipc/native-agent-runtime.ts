import {
  getNativeWorker,
  type NativeWorkerLifecycleEvent,
  type NativeWorkerRawEventFrame
} from '../lib/native-worker'
import {
  RUNTIME_JOB_ROUTES,
  type RuntimeJobEventRecord,
  type RuntimeJobRecord
} from '../../shared/runtime-job-contract'
import { getSession } from '../db/sessions-dao'
import { canaryLookupRuntimeToolResults } from '../db/legacy-read-canary'
import { businessWriteCanary } from '../db/business-write-canary'
import { loadOfflineWorkspaceIds } from '../remote/account-client'

type RawEventHandler = (frame: NativeWorkerRawEventFrame) => void
type RequestHandler = (id: number | string, method: string, params: unknown) => Promise<unknown>
type InterruptedRun = { runId: string; sessionId?: string }
type RunInterruptedHandler = (run: InterruptedRun) => void

type NativeReverseRequest = {
  id?: number | string
  method?: string
  params?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function requireRuntimeJobWorkspace(workspaceId: string): Promise<string> {
  if (!workspaceId || workspaceId !== workspaceId.trim())
    throw new Error('Runtime job workspace is invalid')
  if (workspaceId !== 'local-personal' && !(await loadOfflineWorkspaceIds()).has(workspaceId))
    throw new Error('Runtime job workspace is not available')
  return workspaceId
}

export class NativeAgentRuntimeManager {
  private running = false
  private rawEventHandler: RawEventHandler | null = null
  private rawEventListeners = new Set<RawEventHandler>()
  private requestHandler: RequestHandler | null = null
  private unsubscribeRawAgentStream: (() => void) | null = null
  private unsubscribeReverseRequest: (() => void) | null = null
  private unsubscribeWorkerLifecycle: (() => void) | null = null
  private activeRuns = new Map<string, InterruptedRun>()
  private runInterruptedHandlers = new Set<RunInterruptedHandler>()
  private quiescingForHandover = false
  private runAdmissionsInFlight = 0
  private workspaceSwitchPending = false

  get isRunning(): boolean {
    return this.running && getNativeWorker().isRunning
  }

  setRawEventHandler(handler: RawEventHandler): void {
    this.rawEventHandler = handler
  }

  addRawEventListener(handler: RawEventHandler): () => void {
    this.rawEventListeners.add(handler)
    this.installEventBridge()
    return () => {
      this.rawEventListeners.delete(handler)
    }
  }

  setRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  setSessionVisibility(sessionId: string, visible: boolean): void {
    this.notify('agent/session-visibility', { sessionId, visible })
  }

  hasActiveRuns(): boolean {
    return this.activeRuns.size > 0
  }

  hasRunAdmissionOrActiveRuns(): boolean {
    return this.runAdmissionsInFlight > 0 || this.activeRuns.size > 0
  }

  /** Temporarily closes Agent admission while Main checks and switches workspaces. */
  beginWorkspaceSwitch(): () => void {
    if (this.workspaceSwitchPending || this.hasRunAdmissionOrActiveRuns())
      throw new Error('WORKSPACE_BUSY_AGENT')
    this.workspaceSwitchPending = true
    let released = false
    return () => {
      if (released) return
      released = true
      this.workspaceSwitchPending = false
    }
  }

  /** Irreversible in this process: failed handovers must not resume legacy writes. */
  async quiesceForHandover(): Promise<void> {
    this.quiescingForHandover = true
    // A successful or failed handover is irreversible in this process. Mark
    // the Agent bridge unavailable immediately so status/cleanup calls cannot
    // implicitly restart or reuse the parked Native Worker.
    this.running = false
    if (this.runAdmissionsInFlight > 0 || this.activeRuns.size > 0)
      throw new Error('NATIVE_AGENT_RUNS_ACTIVE_DURING_HANDOVER')
    const worker = getNativeWorker()
    if (!worker.isRunning) return
    const active = await worker.request<unknown>('agent/active-runs', {}, 10_000)
    if (!Array.isArray(active)) throw new Error('NATIVE_AGENT_RUN_STATE_UNAVAILABLE')
    if (active.length > 0) throw new Error('NATIVE_AGENT_RUNS_ACTIVE_DURING_HANDOVER')
  }

  onRunInterrupted(handler: RunInterruptedHandler): () => void {
    this.runInterruptedHandlers.add(handler)
    return () => this.runInterruptedHandlers.delete(handler)
  }

  async start(): Promise<boolean> {
    if (this.quiescingForHandover) throw new Error('NATIVE_AGENT_HANDOVER_QUIESCED')
    await getNativeWorker().ensureStarted()
    this.installEventBridge()
    await getNativeWorker().request('initialize', { runtime: 'agent' }, 30_000)
    this.running = true
    return true
  }

  async ensureStarted(): Promise<boolean> {
    if (this.isRunning) return true
    return await this.start()
  }

  async stop(): Promise<void> {
    if (getNativeWorker().isRunning) {
      await getNativeWorker()
        .request('shutdown', { runtime: 'agent' }, 30_000)
        .catch(() => {})
    }
    this.activeRuns.clear()
    this.running = false
    this.unsubscribeRawAgentStream?.()
    this.unsubscribeRawAgentStream = null
    this.unsubscribeReverseRequest?.()
    this.unsubscribeReverseRequest = null
    this.unsubscribeWorkerLifecycle?.()
    this.unsubscribeWorkerLifecycle = null
  }

  async getActiveRuns(): Promise<unknown> {
    await this.ensureStarted()
    return await getNativeWorker().request('agent/active-runs', {}, 10_000)
  }

  async runStatus(runId: string): Promise<unknown> {
    await this.ensureStarted()
    return await getNativeWorker().request('agent/run-status', { runId }, 10_000)
  }

  async runSnapshot(runId: string): Promise<unknown> {
    const worker = getNativeWorker()
    if (!this.isRunning) {
      return { active: false, run: null, lastSeq: 0, generation: worker.generation }
    }
    const snapshot = await worker.request<Record<string, unknown>>(
      'agent/run-snapshot',
      { runId },
      10_000
    )
    return { ...snapshot, generation: worker.generation }
  }

  async lookupToolResults(sessionId: string, toolUseIds: string[]): Promise<unknown> {
    await this.ensureStarted()
    const session = await getSession(sessionId)
    if (!session) throw new Error('Tool result session not found')
    const workspaceId = session.workspace_id
    if (workspaceId !== 'local-personal' && !(await loadOfflineWorkspaceIds()).has(workspaceId))
      throw new Error('Tool result workspace is not available')
    const canary = await canaryLookupRuntimeToolResults({ sessionId, workspaceId, toolUseIds })
    const result =
      canary !== undefined
        ? canary
        : await getNativeWorker().request(
            'agent/tool-results-lookup',
            { sessionId, workspaceId, toolUseIds },
            10_000
          )
    const currentSession = await getSession(sessionId)
    if (currentSession?.workspace_id !== workspaceId)
      throw new Error('Tool result session workspace changed during lookup')
    if (workspaceId !== 'local-personal' && !(await loadOfflineWorkspaceIds()).has(workspaceId))
      throw new Error('Tool result workspace is not available')
    return result
  }

  async getRuntimeJob(jobId: string, workspaceId: string): Promise<RuntimeJobRecord | null> {
    await this.ensureStarted()
    const scopedWorkspaceId = await requireRuntimeJobWorkspace(workspaceId)
    const writer = businessWriteCanary()
    if (writer) return writer.runtimeJob(jobId, scopedWorkspaceId)
    const result = await getNativeWorker().request<{ found?: boolean; job?: RuntimeJobRecord }>(
      RUNTIME_JOB_ROUTES.get,
      { jobId, workspaceId: scopedWorkspaceId },
      10_000
    )
    return result.found === true ? (result.job ?? null) : null
  }

  async listRuntimeJobs(workspaceId: string, limit = 100): Promise<RuntimeJobRecord[]> {
    await this.ensureStarted()
    const scopedWorkspaceId = await requireRuntimeJobWorkspace(workspaceId)
    const writer = businessWriteCanary()
    if (writer) return writer.runtimeJobs(scopedWorkspaceId, limit)
    return await getNativeWorker().request<RuntimeJobRecord[]>(
      RUNTIME_JOB_ROUTES.list,
      { workspaceId: scopedWorkspaceId, limit },
      10_000
    )
  }

  async cancelRuntimeJob(jobId: string, workspaceId: string): Promise<RuntimeJobRecord | null> {
    await this.ensureStarted()
    const scopedWorkspaceId = await requireRuntimeJobWorkspace(workspaceId)
    const writer = businessWriteCanary()
    if (writer) return writer.cancelRuntimeJob(jobId, scopedWorkspaceId, Date.now())
    return await getNativeWorker().request<RuntimeJobRecord | null>(
      'runtime/jobs-cancel',
      { jobId, workspaceId: scopedWorkspaceId },
      10_000
    )
  }

  async replayRuntimeJobEvents(
    jobId: string,
    workspaceId: string,
    afterSeq = 0
  ): Promise<RuntimeJobEventRecord[]> {
    await this.ensureStarted()
    const scopedWorkspaceId = await requireRuntimeJobWorkspace(workspaceId)
    const writer = businessWriteCanary()
    if (writer) return writer.runtimeJobEvents(jobId, scopedWorkspaceId, afterSeq)
    return await getNativeWorker().request<RuntimeJobEventRecord[]>(
      RUNTIME_JOB_ROUTES.events,
      { jobId, workspaceId: scopedWorkspaceId, afterSeq },
      10_000
    )
  }

  async request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const submittingRun = method === 'agent/run'
    if (submittingRun) {
      if (this.quiescingForHandover) throw new Error('NATIVE_AGENT_HANDOVER_QUIESCED')
      if (this.workspaceSwitchPending) throw new Error('WORKSPACE_BUSY_AGENT')
      this.runAdmissionsInFlight++
    }
    try {
      const writer = businessWriteCanary()
      if (writer && isRecord(params)) {
        if (method === RUNTIME_JOB_ROUTES.submit) {
          const workspaceId = await requireRuntimeJobWorkspace(String(params.workspaceId ?? ''))
          return writer.submitRuntimeJob({
            jobId: String(params.jobId ?? ''),
            workspaceId,
            method: String(params.method ?? ''),
            paramsJson: String(params.paramsJson ?? '{}'),
            createdAt: Number(params.createdAt ?? Date.now()),
            runId: typeof params.runId === 'string' ? params.runId : null,
            sessionId: typeof params.sessionId === 'string' ? params.sessionId : null,
            idempotencyKey:
              typeof params.idempotencyKey === 'string' ? params.idempotencyKey : null,
            laneKey: typeof params.laneKey === 'string' ? params.laneKey : null
          })
        }
        if (method === RUNTIME_JOB_ROUTES.setState) {
          const workspaceId = await requireRuntimeJobWorkspace(String(params.workspaceId ?? ''))
          return writer.setRuntimeJobState({
            jobId: String(params.jobId ?? ''),
            workspaceId,
            state: params.state as import('../../shared/runtime-job-contract').RuntimeJobState,
            updatedAt: Number(params.updatedAt ?? Date.now()),
            errorCode: typeof params.errorCode === 'string' ? params.errorCode : null,
            errorMessage: typeof params.errorMessage === 'string' ? params.errorMessage : null
          })
        }
        if (method === RUNTIME_JOB_ROUTES.cancel) {
          const workspaceId = await requireRuntimeJobWorkspace(String(params.workspaceId ?? ''))
          return writer.cancelRuntimeJob(
            String(params.jobId ?? ''),
            workspaceId,
            Number(params.updatedAt ?? Date.now())
          )
        }
        if (method === RUNTIME_JOB_ROUTES.reapStale) {
          return writer.reapStaleRuntimeJobs(
            Date.now(),
            typeof params.maxAgeMs === 'number' ? params.maxAgeMs : undefined
          )
        }
      }
      await this.ensureStarted()
      if (submittingRun && this.quiescingForHandover)
        throw new Error('NATIVE_AGENT_HANDOVER_QUIESCED')
      if (submittingRun && this.workspaceSwitchPending) throw new Error('WORKSPACE_BUSY_AGENT')
      const result = await getNativeWorker().request(method, params ?? {}, timeoutMs)
      if (
        submittingRun &&
        isRecord(result) &&
        result.started === true &&
        typeof result.runId === 'string'
      ) {
        const runParams = isRecord(params) ? params : {}
        this.activeRuns.set(result.runId, {
          runId: result.runId,
          ...(typeof runParams.sessionId === 'string' ? { sessionId: runParams.sessionId } : {})
        })
      }
      return result
    } finally {
      if (submittingRun) this.runAdmissionsInFlight--
    }
  }

  notify(method: string, params?: unknown): void {
    if (!this.running) return
    void getNativeWorker()
      .request(method, params ?? {}, 10_000)
      .catch((error) => {
        console.warn(
          `[NativeAgentRuntime] notify failed: ${method}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
  }

  private installEventBridge(): void {
    if (!this.unsubscribeRawAgentStream) {
      this.unsubscribeRawAgentStream = getNativeWorker().onRawEvent('agent/stream', (frame) => {
        if (frame.hasTerminalEvent && frame.runId) {
          this.activeRuns.delete(frame.runId)
        }
        this.rawEventHandler?.(frame)
        for (const listener of this.rawEventListeners) {
          listener(frame)
        }
      })
    }

    if (!this.unsubscribeReverseRequest) {
      this.unsubscribeReverseRequest = getNativeWorker().onEvent(
        'agent/reverse-request',
        (params) => {
          void this.handleReverseRequest(params as NativeReverseRequest)
        }
      )
    }

    if (!this.unsubscribeWorkerLifecycle) {
      this.unsubscribeWorkerLifecycle = getNativeWorker().onLifecycle((event) => {
        this.handleWorkerLifecycle(event)
      })
    }
  }

  private handleWorkerLifecycle(event: NativeWorkerLifecycleEvent): void {
    if (event.status === 'restarting') {
      const interruptedRuns = [...this.activeRuns.values()]
      this.activeRuns.clear()
      for (const run of interruptedRuns) {
        for (const handler of this.runInterruptedHandlers) handler(run)
      }
      return
    }

    if (event.status === 'ready' && this.running) {
      void getNativeWorker()
        .request('initialize', { runtime: 'agent' }, 30_000)
        .catch((error) => {
          console.warn(
            `[NativeAgentRuntime] initialize after worker recovery failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        })
    }
  }

  private async handleReverseRequest(request: NativeReverseRequest): Promise<void> {
    const id = request?.id
    const method = request?.method
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof method !== 'string') {
      return
    }

    if (!this.requestHandler) {
      await this.sendReverseResponse(id, undefined, 'No reverse request handler registered')
      return
    }

    try {
      const result = await this.requestHandler(id, method, request.params ?? {})
      await this.sendReverseResponse(id, result, undefined)
    } catch (error) {
      await this.sendReverseResponse(
        id,
        undefined,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  async cancelReverseRequest(id: number | string): Promise<boolean> {
    const result = await getNativeWorker().request<{ ok?: boolean }>(
      'agent/reverse-cancel',
      { id },
      10_000
    )
    return result.ok === true
  }

  private async sendReverseResponse(
    id: number | string,
    result: unknown,
    error: string | undefined
  ): Promise<void> {
    await getNativeWorker()
      .request(
        'agent/reverse-response',
        {
          id,
          ...(typeof error === 'string' ? { error } : { result })
        },
        30_000
      )
      .catch((sendError) => {
        console.warn(
          `[NativeAgentRuntime] reverse response failed: ${
            sendError instanceof Error ? sendError.message : String(sendError)
          }`
        )
      })
  }
}

let nativeAgentRuntimeManager: NativeAgentRuntimeManager | null = null

export function getNativeAgentRuntimeManager(): NativeAgentRuntimeManager {
  if (!nativeAgentRuntimeManager) {
    nativeAgentRuntimeManager = new NativeAgentRuntimeManager()
  }
  return nativeAgentRuntimeManager
}
