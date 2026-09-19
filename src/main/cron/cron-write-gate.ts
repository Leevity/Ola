const activeWrites = new Set<Promise<unknown>>()
let quiescingForHandover = false

/** Tracks every Main-origin Cron mutation until the Native request settles. */
export async function guardedCronWrite<T>(operation: () => Promise<T>): Promise<T> {
  if (quiescingForHandover) throw new Error('CRON_WRITES_QUIESCING')
  const write = Promise.resolve().then(operation)
  activeWrites.add(write)
  try {
    return await write
  } finally {
    activeWrites.delete(write)
  }
}

/** Irreversible in this process: a failed handover must remain parked. */
export function quiesceCronWritesForHandover(): void {
  quiescingForHandover = true
  if (activeWrites.size > 0) throw new Error('CRON_WRITES_ACTIVE_DURING_HANDOVER')
}
