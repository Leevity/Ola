import { ModelBindingError } from '../../shared/runtime/model-source'
import {
  parseRunSpec,
  RuntimeError,
  TERMINAL_STATUSES,
  type RunEvent,
  type RunRecord,
  type RunSpec,
  type PendingRuntimeInteraction,
  type RunSnapshot
} from '../../shared/runtime/contracts'
import { RunJournal } from '../storage/run-journal'

export interface ExecutionContext {
  signal: AbortSignal
  emit: (type: string, data: unknown) => Promise<void>
  requestInteraction: (
    interaction: Omit<PendingRuntimeInteraction, 'runId' | 'workspaceId' | 'createdAt'>
  ) => Promise<unknown>
  /** Submit and await a nested run without exposing the scheduler to tools. */
  runNested?: (input: unknown) => Promise<RunSnapshot>
  /** Submit a nested run for background execution and observe its terminal snapshot. */
  submitNested?: (
    input: unknown,
    onTerminal?: (snapshot: RunSnapshot) => Promise<void>
  ) => Promise<RunRecord>
}
export type RunExecutor = (run: RunSpec, context: ExecutionContext) => Promise<void>

/** Session ownership is held until the executor settles, including during cancellation. */
export class RunScheduler {
  private queue: RunRecord[] = []
  private running = new Map<
    string,
    { run: RunRecord; controller: AbortController; done: Promise<void> }
  >()
  private listeners = new Set<(event: RunEvent) => void>()
  private commandTail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private activeWorkspaceId = 'local-personal'
  private interactionWaiters = new Map<
    string,
    Map<string, { resolve: (response: unknown) => void; reject: (error: Error) => void }>
  >()
  constructor(
    readonly journal: RunJournal,
    private readonly execute: RunExecutor,
    private readonly authorize: (run: RunSpec) => Promise<void>,
    private readonly concurrency = 4
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new RuntimeError('INVALID_CONCURRENCY')
  }
  async initialize(): Promise<void> {
    for (const event of await this.journal.recover()) this.publish(event)
  }
  onEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(event: RunEvent | null): void {
    if (!event) return
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* A failed subscriber cannot invalidate a committed event. */
      }
    }
  }
  private serialize<T>(command: () => Promise<T>): Promise<T> {
    const result = this.commandTail.then(command)
    this.commandTail = result.catch(() => undefined)
    return result
  }
  submit(input: unknown): Promise<RunRecord> {
    return this.serialize(async () => {
      if (this.stopped) throw new RuntimeError('RUNTIME_STOPPED')
      const spec = parseRunSpec(input)
      await this.authorize(spec)
      const result = await this.journal.create(spec)
      if (result.created) {
        this.queue.push(result.run)
        const snapshot = await this.journal.snapshot(spec.runId, spec.workspaceId)
        for (const event of snapshot?.events ?? []) this.publish(event)
        this.pump()
      }
      return result.run
    })
  }
  cancel(runId: string, workspaceId: string): Promise<void> {
    return this.serialize(async () => {
      const snapshot = await this.journal.snapshot(runId, workspaceId)
      if (!snapshot) throw new RuntimeError('RUN_NOT_FOUND')
      if (TERMINAL_STATUSES.has(snapshot.run.status)) return
      const pending = this.queue.findIndex((run) => run.runId === runId)
      if (pending !== -1) {
        this.queue.splice(pending, 1)
        this.publish(await this.journal.transition(runId, workspaceId, ['queued'], 'cancelled'))
      } else {
        this.rejectInteractions(runId, new RuntimeError('RUN_CANCELLED'))
        this.publish(await this.journal.abandonInteractions(runId, workspaceId, 'RUN_CANCELLED'))
        this.publish(
          await this.journal.transition(
            runId,
            workspaceId,
            ['queued', 'running', 'waiting_interaction', 'waiting_capability'],
            'cancelling'
          )
        )
        this.running.get(runId)?.controller.abort(new RuntimeError('RUN_CANCELLED'))
      }
    })
  }
  async cancelSessionRuns(workspaceId: string, sessionId: string): Promise<void> {
    const matching = [...this.queue, ...[...this.running.values()].map(({ run }) => run)].filter(
      (run) => run.workspaceId === workspaceId && run.sessionId === sessionId
    )
    await Promise.all(matching.map((run) => this.cancel(run.runId, workspaceId)))
    const active = [...this.running.values()].filter(
      ({ run }) => run.workspaceId === workspaceId && run.sessionId === sessionId
    )
    await Promise.allSettled(active.map(({ done }) => done))
  }
  revokeUnavailableWorkspaces(availableIds: ReadonlySet<string>): void {
    const revoked = [...this.queue, ...[...this.running.values()].map(({ run }) => run)].filter(
      (run) => run.workspaceId !== 'local-personal' && !availableIds.has(run.workspaceId)
    )
    for (const run of revoked) {
      // Abort active model/tool work immediately; serialized cancellation then
      // commits the terminal state without racing another scheduler command.
      this.running.get(run.runId)?.controller.abort(new RuntimeError('WORKSPACE_FORBIDDEN'))
      void this.cancel(run.runId, run.workspaceId).catch((error) => {
        console.warn('[TS Runtime] Workspace revocation cancellation failed:', error)
      })
    }
  }
  respondInteraction(
    runId: string,
    workspaceId: string,
    interactionId: string,
    response: unknown
  ): Promise<void> {
    return this.serialize(async () => {
      const waiter = this.interactionWaiters.get(runId)?.get(interactionId)
      if (!waiter) throw new RuntimeError('INTERACTION_NOT_PENDING')
      const running = this.running.get(runId)
      if (!running || running.run.workspaceId !== workspaceId)
        throw new RuntimeError('RUN_NOT_FOUND')
      running.controller.signal.throwIfAborted()
      // Approval can wait behind other scheduler commands; recheck the team
      // lease and model binding immediately before committing the response.
      await this.authorize(running.run)
      running.controller.signal.throwIfAborted()
      const result = await this.journal.resolveInteraction(
        runId,
        workspaceId,
        interactionId,
        response
      )
      if (running.controller.signal.aborted) {
        const reason = running.controller.signal.reason ?? new RuntimeError('RUN_CANCELLED')
        waiter.reject(reason)
        throw reason
      }
      this.publish(result.event)
      waiter.resolve(response)
    })
  }
  private rejectInteractions(runId: string, error: Error): void {
    const waiters = this.interactionWaiters.get(runId)
    this.interactionWaiters.delete(runId)
    for (const waiter of waiters?.values() ?? []) waiter.reject(error)
  }
  private async requestInteraction(
    run: RunRecord,
    signal: AbortSignal,
    interaction: Omit<PendingRuntimeInteraction, 'runId' | 'workspaceId' | 'createdAt'>
  ): Promise<unknown> {
    if (run.unattended) throw new RuntimeError('UNATTENDED_INTERACTION_REQUIRED')
    if (signal.aborted) throw signal.reason ?? new RuntimeError('RUN_CANCELLED')
    if (this.interactionWaiters.get(run.runId)?.size)
      throw new RuntimeError('INTERACTION_ALREADY_PENDING')
    let resolve!: (response: unknown) => void
    let reject!: (error: Error) => void
    const waiting = new Promise<unknown>((resolveWaiter, rejectWaiter) => {
      resolve = resolveWaiter
      reject = rejectWaiter
    })
    const waiters = new Map([[interaction.interactionId, { resolve, reject }]])
    this.interactionWaiters.set(run.runId, waiters)
    try {
      await this.journal.createInteraction(run.runId, run.workspaceId, interaction)
      const snapshot = await this.journal.snapshot(run.runId, run.workspaceId)
      const event = snapshot?.events.at(-1)
      if (event?.type === 'interaction.requested') this.publish(event)
      return await new Promise<unknown>((resolveWaiter, rejectWaiter) => {
        const abort = (): void => rejectWaiter(signal.reason ?? new RuntimeError('RUN_CANCELLED'))
        signal.addEventListener('abort', abort, { once: true })
        void waiting
          .then(resolveWaiter, rejectWaiter)
          .finally(() => signal.removeEventListener('abort', abort))
      })
    } finally {
      if (this.interactionWaiters.get(run.runId) === waiters)
        this.interactionWaiters.delete(run.runId)
    }
  }
  switchWorkspace(
    workspaceId: string,
    permittedWorkspaceIds: ReadonlySet<string>,
    externalBusy = false
  ): Promise<void> {
    return this.serialize(async () => {
      if (!permittedWorkspaceIds.has(workspaceId)) throw new RuntimeError('WORKSPACE_FORBIDDEN')
      if (workspaceId === this.activeWorkspaceId) return
      if (
        externalBusy ||
        this.queue.length ||
        this.running.size ||
        (await this.journal.active()).length
      )
        throw new RuntimeError('WORKSPACE_BUSY')
      this.activeWorkspaceId = workspaceId
    })
  }
  private pump(): void {
    if (this.stopped) return
    while (this.running.size < this.concurrency) {
      const sessions = new Set(
        [...this.running.values()].map(({ run }) =>
          JSON.stringify([run.workspaceId, run.sessionId])
        )
      )
      const index = this.queue.findIndex(
        (run) => !sessions.has(JSON.stringify([run.workspaceId, run.sessionId]))
      )
      if (index < 0) return
      const [run] = this.queue.splice(index, 1)
      const controller = new AbortController()
      const entry = { run, controller, done: Promise.resolve() }
      this.running.set(run.runId, entry)
      entry.done = this.perform(run, controller).finally(() => {
        this.running.delete(run.runId)
        this.pump()
      })
    }
  }
  private async perform(run: RunRecord, controller: AbortController): Promise<void> {
    try {
      const started = await this.journal.transition(
        run.runId,
        run.workspaceId,
        ['queued'],
        'running'
      )
      this.publish(started)
      controller.signal.throwIfAborted()
      // Authorization may have been revoked while this run waited in the queue.
      await this.authorize(run)
      await this.execute(run, {
        signal: controller.signal,
        emit: async (type, data) => {
          controller.signal.throwIfAborted()
          if (type === 'run.status') throw new RuntimeError('RESERVED_EVENT_TYPE')
          this.publish(await this.journal.append(run.runId, run.workspaceId, type, data))
        },
        requestInteraction: (interaction) =>
          this.requestInteraction(run, controller.signal, interaction),
        runNested: (input) => this.runNested(input, controller.signal),
        submitNested: (input, onTerminal) => this.submitNested(input, onTerminal)
      })
      // Serialize the final transition with cancellation so only one terminal outcome wins.
      await this.serialize(async () => {
        this.publish(
          await this.journal.transition(
            run.runId,
            run.workspaceId,
            ['running', 'cancelling'],
            controller.signal.aborted ? 'cancelled' : 'completed'
          )
        )
      })
    } catch (error) {
      this.rejectInteractions(
        run.runId,
        error instanceof Error ? error : new RuntimeError('EXECUTION_FAILED')
      )
      this.publish(
        await this.journal
          .abandonInteractions(
            run.runId,
            run.workspaceId,
            controller.signal.aborted ? 'RUN_CANCELLED' : 'EXECUTION_FAILED'
          )
          .catch(() => null)
      )
      await this.serialize(async () => {
        this.publish(
          await this.journal.transition(
            run.runId,
            run.workspaceId,
            ['queued', 'running', 'cancelling', 'waiting_interaction', 'waiting_capability'],
            controller.signal.aborted ? 'cancelled' : 'failed',
            error instanceof RuntimeError || error instanceof ModelBindingError
              ? error.code
              : 'EXECUTION_FAILED'
          )
        )
      }).catch(() => {
        this.stopped = true
        for (const active of this.running.values()) active.controller.abort()
      })
    }
  }

  private async runNested(input: unknown, parentSignal: AbortSignal): Promise<RunSnapshot> {
    const child = await this.submit(input)
    while (true) {
      parentSignal.throwIfAborted()
      const snapshot = await this.journal.snapshot(child.runId, child.workspaceId)
      if (!snapshot) throw new RuntimeError('RUN_NOT_FOUND')
      if (TERMINAL_STATUSES.has(snapshot.run.status)) return snapshot
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(parentSignal.reason ?? new RuntimeError('RUN_CANCELLED'))
        const timer = setTimeout(() => {
          parentSignal.removeEventListener('abort', abort)
          resolve()
        }, 40)
        parentSignal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            abort()
          },
          { once: true }
        )
      }).catch(async (error) => {
        await this.cancel(child.runId, child.workspaceId).catch(() => undefined)
        throw error
      })
    }
  }

  private async submitNested(
    input: unknown,
    onTerminal?: (snapshot: RunSnapshot) => Promise<void>
  ): Promise<RunRecord> {
    const child = await this.submit(input)
    if (onTerminal) void this.watchNestedTerminal(child, onTerminal)
    return child
  }

  private async watchNestedTerminal(
    child: RunRecord,
    onTerminal: (snapshot: RunSnapshot) => Promise<void>
  ): Promise<void> {
    try {
      while (true) {
        const snapshot = await this.journal.snapshot(child.runId, child.workspaceId)
        if (!snapshot) return
        if (TERMINAL_STATUSES.has(snapshot.run.status)) {
          await onTerminal(snapshot)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    } catch (error) {
      // Completion projection is best effort and must never become an
      // unhandled rejection that destabilizes the scheduler.
      console.warn('[TS Runtime] Nested terminal projection failed:', error)
    }
  }
  async stop(): Promise<void> {
    await this.serialize(async () => {
      this.stopped = true
      for (const { controller } of this.running.values())
        controller.abort(new RuntimeError('RUNTIME_STOPPED'))
      for (const runId of this.interactionWaiters.keys())
        this.rejectInteractions(runId, new RuntimeError('RUNTIME_STOPPED'))
      for (const run of this.queue)
        this.publish(
          await this.journal.transition(
            run.runId,
            run.workspaceId,
            ['queued'],
            'cancelled',
            'RUNTIME_STOPPED'
          )
        )
      this.queue = []
    })
    await Promise.all([...this.running.values()].map(({ done }) => done))
  }
}
