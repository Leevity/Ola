/** Prevents a handover snapshot from racing an already-admitted Worker request. */
export class NativeWorkerRequestGate {
  private closed = false
  private active = new Set<Promise<unknown>>()

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('NATIVE_WORKER_HANDOVER_QUIESCED'))
    const task = Promise.resolve().then(operation)
    this.active.add(task)
    void task.then(
      () => this.active.delete(task),
      () => this.active.delete(task)
    )
    return task
  }

  async quiesce(timeoutMs = 10_000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000)
      throw new Error('Invalid native worker request drain timeout')
    this.closed = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const settled = await Promise.race([
        Promise.allSettled([...this.active]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('NATIVE_WORKER_REQUEST_DRAIN_TIMEOUT')),
            timeoutMs
          )
        })
      ])
      if (settled.some((result) => result.status === 'rejected'))
        throw new Error('NATIVE_WORKER_REQUEST_FAILED_DURING_HANDOVER')
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
