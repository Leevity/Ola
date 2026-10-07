export interface PendingSessionQueueRecord {
  id: string
  text: string
  createdAt: number
  recoveryState?: 'dispatching' | 'needs_review'
}

function isPendingSessionQueueRecord(value: unknown): value is PendingSessionQueueRecord {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PendingSessionQueueRecord>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.text === 'string' &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt)
  )
}

export function recoverPendingSessionQueue<T extends PendingSessionQueueRecord>(
  persisted: unknown,
  current: T[],
  limit: number
): T[] {
  if (!Array.isArray(persisted)) throw new Error('INVALID_PENDING_SESSION_QUEUE_RESPONSE')

  const recovered = persisted
    .filter(isPendingSessionQueueRecord)
    .map((message) =>
      message.recoveryState === 'dispatching'
        ? ({ ...message, recoveryState: 'needs_review' as const } as T)
        : (message as T)
    )
    .slice(0, limit)
  const byId = new Map<string, T>()
  for (const message of [...recovered, ...current]) {
    const previous = byId.get(message.id)
    const merged = { ...previous, ...message }
    byId.set(
      message.id,
      previous?.recoveryState === 'needs_review' || message.recoveryState === 'needs_review'
        ? ({ ...merged, recoveryState: 'needs_review' } as T)
        : (merged as T)
    )
  }
  const reviewItems = [...byId.values()].filter(
    (message) => message.recoveryState === 'needs_review'
  )
  const queuedItems = [...byId.values()]
    .filter((message) => message.recoveryState !== 'needs_review')
    .sort((left, right) => left.createdAt - right.createdAt)

  return [...reviewItems, ...queuedItems].slice(0, limit)
}
