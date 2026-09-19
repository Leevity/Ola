/** Irreversible admission gate for draining legacy sync before business DB handover. */
export class SyncHandoverGate {
  private quiescing = false
  private active = 0
  private waiters = new Set<() => void>()

  enter(): () => void {
    if (this.quiescing) throw new Error('SYNC_HANDOVER_QUIESCING')
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      if (this.active === 0) {
        for (const waiter of this.waiters) waiter()
        this.waiters.clear()
      }
    }
  }

  async quiesce(timeoutMs = 120_000): Promise<void> {
    this.quiescing = true
    if (this.active === 0) return
    await new Promise<void>((resolve, reject) => {
      const onDrained = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.waiters.delete(onDrained)
        reject(new Error('SYNC_RUNS_ACTIVE_DURING_HANDOVER'))
      }, timeoutMs)
      this.waiters.add(onDrained)
    })
  }
}
