/**
 * New sessions are created with an English sentinel title (`chat-store.ts`). Several flows use
 * that literal to detect "title not generated yet", so the stored value must stay stable — but
 * the UI should never show an English label in a localized interface. Translate at display time.
 */
export const UNTITLED_SESSION_TITLES: ReadonlySet<string> = new Set([
  'New Conversation',
  'New Chat'
])

export function isUntitledSessionTitle(title: string | null | undefined): boolean {
  return !title || UNTITLED_SESSION_TITLES.has(title)
}

export function localizeSessionTitle(
  title: string | null | undefined,
  translate: (key: string) => string
): string {
  return isUntitledSessionTitle(title) ? translate('layout:sidebar.newChat') : title!
}
