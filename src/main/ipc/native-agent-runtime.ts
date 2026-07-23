import {
  getNativeWorker,
  type NativeWorkerLifecycleEvent,
  type NativeWorkerRawEventFrame
} from '../lib/native-worker'

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

  onRunInterrupted(handler: RunInterruptedHandler): () => void {
    this.runInterruptedHandlers.add(handler)
    return () => this.runInterruptedHandlers.delete(handler)
  }

  async start(): Promise<boolean> {
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

  async request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    await this.ensureStarted()
    const result = await getNativeWorker().request(method, params ?? {}, timeoutMs)
    if (
      method === 'agent/run' &&
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
