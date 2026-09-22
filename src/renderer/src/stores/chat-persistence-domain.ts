export type PersistenceWrite = () => Promise<unknown>

/** Serializes writes per session while allowing independent sessions to persist concurrently. */
export class SessionPersistenceQueue {
  private readonly queues = new Map<string, Promise<void>>()

  enqueue(sessionId: string, write: PersistenceWrite, shouldWrite: () => boolean = () => true): Promise<void> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (!shouldWrite()) return
        await write()
      })
      .then(
        () => undefined,
        () => undefined
      )

    this.queues.set(sessionId, next)
    void next.finally(() => {
      if (this.queues.get(sessionId) === next) this.queues.delete(sessionId)
    })
    return next
  }

  pending(sessionId: string): Promise<void> {
    return this.queues.get(sessionId) ?? Promise.resolve()
  }

  clear(sessionId?: string): void {
    if (sessionId) this.queues.delete(sessionId)
    else this.queues.clear()
  }
}
