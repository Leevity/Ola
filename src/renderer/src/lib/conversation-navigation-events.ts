export interface ConversationNavigationTarget {
  sessionId?: string | null
  messageId: string
  runId?: string
  changeId?: string | null
}

type ConversationNavigationListener = (target: ConversationNavigationTarget) => void

const listeners = new Set<ConversationNavigationListener>()

export function navigateToConversationTarget(target: ConversationNavigationTarget): void {
  for (const listener of listeners) listener(target)
}

export function navigateToMessage(
  messageId: string,
  options: Omit<ConversationNavigationTarget, 'messageId'> = {}
): void {
  navigateToConversationTarget({ messageId, ...options })
}

export function navigateToRun(
  messageId: string,
  runId: string,
  options: Omit<ConversationNavigationTarget, 'messageId' | 'runId'> = {}
): void {
  navigateToConversationTarget({ messageId, runId, ...options })
}

export function navigateToChange(
  messageId: string,
  runId: string,
  changeId?: string | null,
  options: Omit<ConversationNavigationTarget, 'messageId' | 'runId' | 'changeId'> = {}
): void {
  navigateToConversationTarget({ messageId, runId, changeId, ...options })
}

export function subscribeToConversationNavigation(
  listener: ConversationNavigationListener
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
