export type PersistenceWrite = () => Promise<unknown>

/** Treat a lost delete response as success only when a read-back confirms the row is gone. */
export async function reconcileSessionDeleteResponse(
  error: unknown,
  exists: () => Promise<boolean>
): Promise<void> {
  if (await exists()) throw error
}

/** Keeps a failed create observable after its in-flight promise has settled. */
export class SessionCreationGate {
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly failures = new Map<string, unknown>()
  private readonly generations = new Map<string, object>()
  private readonly recoveries = new Map<string, Promise<void>>()

  track(sessionId: string, operation: Promise<unknown>): Promise<unknown> {
    const generation = {}
    this.generations.set(sessionId, generation)
    this.failures.delete(sessionId)
    const tracked = operation
      .then(
        (value) => {
          if (this.generations.get(sessionId) === generation) this.failures.delete(sessionId)
          return value
        },
        (error: unknown) => {
          if (this.generations.get(sessionId) === generation) this.failures.set(sessionId, error)
          throw error
        }
      )
      .finally(() => {
        if (this.pending.get(sessionId) === tracked) {
          this.pending.delete(sessionId)
          this.generations.delete(sessionId)
        }
      })
    this.pending.set(sessionId, tracked)
    return tracked
  }

  async wait(sessionId: string): Promise<void> {
    await this.pending.get(sessionId)
    if (this.failures.has(sessionId)) throw this.failures.get(sessionId)
  }

  async runAfterCreation<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
    await this.wait(sessionId)
    return write()
  }

  async ensureCreated(
    sessionId: string,
    exists: () => Promise<boolean>,
    retry: () => Promise<void>
  ): Promise<void> {
    try {
      await this.wait(sessionId)
      return
    } catch (error) {
      if (!this.hasFailure(sessionId)) throw error
    }

    let recovery = this.recoveries.get(sessionId)
    if (!recovery) {
      recovery = (async () => {
        if (await exists()) {
          this.clearFailure(sessionId)
          return
        }
        try {
          await retry()
        } catch (error) {
          if (!(await exists())) throw error
          this.clearFailure(sessionId)
        }
      })()
      this.recoveries.set(sessionId, recovery)
      void recovery.then(
        () => {
          if (this.recoveries.get(sessionId) === recovery) this.recoveries.delete(sessionId)
        },
        () => {
          if (this.recoveries.get(sessionId) === recovery) this.recoveries.delete(sessionId)
        }
      )
    }
    await recovery
  }

  hasFailure(sessionId: string): boolean {
    return this.failures.has(sessionId)
  }

  clearFailure(sessionId: string): void {
    this.failures.delete(sessionId)
  }
}

/** Serializes writes per session while allowing independent sessions to persist concurrently. */
export class SessionPersistenceQueue {
  private readonly queues = new Map<string, Promise<void>>()

  enqueue(
    sessionId: string,
    write: PersistenceWrite,
    shouldWrite: () => boolean = () => true
  ): Promise<void> {
    return this.enqueueStrict(sessionId, write, shouldWrite).then(
      () => undefined,
      () => undefined
    )
  }

  enqueueStrict(
    sessionId: string,
    write: PersistenceWrite,
    shouldWrite: () => boolean = () => true
  ): Promise<void> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const operation = previous
      .catch(() => {})
      .then(async () => {
        if (!shouldWrite()) return
        await write()
      })
    const next = operation.then(
      () => undefined,
      () => undefined
    )

    this.queues.set(sessionId, next)
    void next.finally(() => {
      if (this.queues.get(sessionId) === next) this.queues.delete(sessionId)
    })
    return operation
  }

  pending(sessionId: string): Promise<void> {
    return this.queues.get(sessionId) ?? Promise.resolve()
  }

  clear(sessionId?: string): void {
    if (sessionId) this.queues.delete(sessionId)
    else this.queues.clear()
  }
}
