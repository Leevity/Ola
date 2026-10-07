/** Refresh visible rows without discarding pages the user has already loaded. */
export function mergeExecutionPage<T>(
  current: readonly T[],
  incoming: readonly T[],
  key: (item: T) => string
): T[] {
  const refreshed = new Map(incoming.map((item) => [key(item), item]))
  return [...refreshed.values(), ...current.filter((item) => !refreshed.has(key(item)))]
}

/** Preserve the existing pagination anchor; refresh exhausted pages when new rows arrive. */
export function refreshedExecutionCursor<T>(
  current: T | null,
  incoming: T | null,
  background: boolean
): T | null {
  return !background || current === null ? incoming : current
}
