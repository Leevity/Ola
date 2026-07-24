const STORAGE_PREFIX = 'ola:conversation-bookmarks:'
const EVENT_NAME = 'ola:conversation-bookmarks-changed'

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`
}

export function getConversationBookmarks(sessionId?: string | null): string[] {
  if (!sessionId) return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(sessionId)) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

export function isConversationBookmarked(
  sessionId: string | null | undefined,
  messageId: string
): boolean {
  return getConversationBookmarks(sessionId).includes(messageId)
}

export function toggleConversationBookmark(
  sessionId: string | null | undefined,
  messageId: string
): boolean {
  if (!sessionId) return false
  const current = getConversationBookmarks(sessionId)
  const bookmarked = !current.includes(messageId)
  const next = bookmarked ? [...current, messageId] : current.filter((id) => id !== messageId)
  window.localStorage.setItem(storageKey(sessionId), JSON.stringify(next))
  window.dispatchEvent(
    new CustomEvent(EVENT_NAME, { detail: { sessionId, messageId, bookmarked } })
  )
  return bookmarked
}

export function subscribeToConversationBookmarks(
  listener: (sessionId: string) => void
): () => void {
  const handle = (event: Event): void => {
    const sessionId = (event as CustomEvent<{ sessionId?: unknown }>).detail?.sessionId
    if (typeof sessionId === 'string') listener(sessionId)
  }
  window.addEventListener(EVENT_NAME, handle)
  return () => window.removeEventListener(EVENT_NAME, handle)
}
