/**
 * Pure primitives shared by the transcript virtualizer and scroll event handlers.
 * Keeping these DOM calculations out of MessageList makes user scroll intent explicit
 * and lets prepend restoration be tested without mounting the chat surface.
 */
export type ViewportMode = 'positioning' | 'following' | 'browsing'
export type OlderLoadIntent = 'history' | 'fill' | 'visibility'

export interface HistoryScrollAnchor {
  messageId: string
  offset: number
}

export const VIEWPORT = {
  scrollEpsilon: 2,
  autoScrollMinDelta: 24,
  streamingBottomThreshold: 80,
  staticBottomThreshold: 24
} as const

export function getDistanceToBottom(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)
}

export function isPhysicallyAtBottom(scroller: HTMLElement, streaming: boolean): boolean {
  return (
    getDistanceToBottom(scroller) <=
    (streaming ? VIEWPORT.streamingBottomThreshold : VIEWPORT.staticBottomThreshold)
  )
}

export function canChaseTail(input: {
  mode: ViewportMode
  streaming: boolean
  userIntent: boolean
}): boolean {
  return input.mode === 'following' && input.streaming && !input.userIntent
}

export function readVisibleMessageAnchor(scroller: HTMLElement): HistoryScrollAnchor | null {
  const scrollerRect = scroller.getBoundingClientRect()
  const visible = Array.from(scroller.querySelectorAll<HTMLElement>('[data-message-id]')).find(
    (element) => {
      const rect = element.getBoundingClientRect()
      return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom
    }
  )
  const messageId = visible?.dataset.messageId
  if (!visible || !messageId) return null
  return { messageId, offset: visible.getBoundingClientRect().top - scrollerRect.top }
}

export function restorePrependScrollOffset(input: {
  previousScrollTop: number
  previousScrollHeight: number
  nextScrollHeight: number
}): number {
  return Math.max(0, input.previousScrollTop + input.nextScrollHeight - input.previousScrollHeight)
}

export function measureRenderedTurnHeight(
  list: HTMLElement,
  lastUserMessageId: string
): number | null {
  const userElement = list.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(lastUserMessageId)}"]`
  )
  if (!userElement) return null

  const userTop = userElement.getBoundingClientRect().top
  let bottom = userElement.getBoundingClientRect().bottom
  for (const element of list.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const rect = element.getBoundingClientRect()
    if (rect.bottom > userTop + 1) bottom = Math.max(bottom, rect.bottom)
  }
  return Math.max(0, Math.round(bottom - userTop))
}
