import * as React from 'react'
import {
  isPhysicallyAtBottom,
  resolveViewportMode,
  shouldRequestOlderLoad,
  type MessageWindowPhase,
  type OlderLoadIntent,
  type ViewportMode
} from './message-list-viewport'

export type { MessageWindowPhase } from './message-list-viewport'

interface UseMessageListViewportOptions {
  sessionId?: string | null
  scrollerRef: React.RefObject<HTMLElement | null>
  messageCount: number
  initialLoading: boolean
  isStreaming: boolean
}

interface ScrollSyncOptions {
  isProgrammatic: boolean
  userIntent?: boolean
}

/**
 * Owns the user-facing transcript state independently from the virtualizer. Keeping this small
 * controller separate from MessageList makes a session switch, a deliberate browse action and
 * an automatic tail-follow mutually exclusive states instead of competing scroll heuristics.
 */
export function useMessageListViewport({
  sessionId,
  scrollerRef,
  messageCount,
  initialLoading,
  isStreaming
}: UseMessageListViewportOptions): {
  phase: MessageWindowPhase
  mode: ViewportMode
  modeRef: React.MutableRefObject<ViewportMode>
  syncScrollMode: (options: ScrollSyncOptions) => ViewportMode
  setMode: (mode: ViewportMode) => void
  requestOlderLoad: (
    intent: OlderLoadIntent,
    options: { hasOlder: boolean; loading: boolean }
  ) => boolean
} {
  const [phase, setPhase] = React.useState<MessageWindowPhase>(sessionId ? 'loading' : 'ready')
  const [mode, setModeState] = React.useState<ViewportMode>(sessionId ? 'positioning' : 'browsing')
  const modeRef = React.useRef<ViewportMode>(sessionId ? 'positioning' : 'browsing')
  const fillPagesRef = React.useRef(0)
  const hasMessages = messageCount > 0

  const setMode = React.useCallback((next: ViewportMode): void => {
    modeRef.current = next
    setModeState((current) => (current === next ? current : next))
  }, [])

  React.useEffect(() => {
    fillPagesRef.current = 0
    if (!sessionId) {
      setPhase('ready')
      setMode('browsing')
      return
    }
    if (initialLoading || !hasMessages) {
      setPhase('loading')
      setMode('positioning')
      return
    }

    setPhase('positioning')
    let cancelled = false
    const secondFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!cancelled) setPhase('ready')
      })
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(secondFrame)
    }
  }, [hasMessages, initialLoading, sessionId, setMode])

  const syncScrollMode = React.useCallback(
    ({ isProgrammatic, userIntent = false }: ScrollSyncOptions): ViewportMode => {
      const scroller = scrollerRef.current
      if (!scroller || isProgrammatic) return modeRef.current
      const next = resolveViewportMode({
        previous: modeRef.current,
        atBottom: isPhysicallyAtBottom(scroller, isStreaming),
        isProgrammatic,
        userIntent
      })
      setMode(next)
      return next
    },
    [isStreaming, scrollerRef, setMode]
  )

  const requestOlderLoad = React.useCallback(
    (intent: OlderLoadIntent, options: { hasOlder: boolean; loading: boolean }): boolean => {
      const accepted = shouldRequestOlderLoad({
        intent,
        hasOlder: options.hasOlder,
        loading: options.loading,
        mode: modeRef.current,
        messageCount,
        fillPages: fillPagesRef.current
      })
      if (accepted && intent === 'fill') fillPagesRef.current += 1
      return accepted
    },
    [messageCount]
  )

  return { phase, mode, modeRef, syncScrollMode, setMode, requestOlderLoad }
}
