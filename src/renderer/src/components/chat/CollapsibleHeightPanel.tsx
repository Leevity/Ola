import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

interface CollapsibleHeightPanelProps {
  open: boolean
  children: React.ReactNode
  className?: string
  contentClassName?: string
  duration?: number
  /** Disable animation without changing the disclosure's semantic state. */
  enabled?: boolean
  /**
   * `scroll-up` gives completed execution detail a clear exit direction. It is deliberately
   * opt-in: ordinary disclosure content should continue to use the quieter clip motion.
   */
  collapseMotion?: 'clip' | 'scroll-up'
}

/**
 * Virtual transcript rows cannot infer a CSS height transition. Every execution disclosure
 * therefore emits one bubbling event when its measured height or animation settles.
 */
export const EXECUTION_RESIZE_EVENT = 'ola:execution-resize'

export function notifyExecutionResize(node: EventTarget | null): void {
  node?.dispatchEvent(new CustomEvent(EXECUTION_RESIZE_EVENT, { bubbles: true }))
}

/**
 * Shared height transition for expandable transcript content. Keeping the animation in one
 * component makes virtual-row measurement predictable and gives reduced-motion users an
 * immediate state change.
 */
export function CollapsibleHeightPanel({
  open,
  children,
  className,
  contentClassName,
  duration = 0.2,
  enabled = true,
  collapseMotion = 'clip'
}: CollapsibleHeightPanelProps): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  const contentRef = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = React.useState(0)

  const canAnimate = enabled && !reduceMotion

  React.useLayoutEffect(() => {
    if (!open || !contentRef.current) return
    const content = contentRef.current
    const measure = (): void => {
      setContentHeight((previous) => {
        const next = content.getBoundingClientRect().height
        return Math.abs(previous - next) > 0.5 ? next : previous
      })
      notifyExecutionResize(panelRef.current)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [open])

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          ref={panelRef}
          initial={canAnimate ? { height: 0, opacity: 0 } : false}
          animate={{ height: canAnimate ? contentHeight : 'auto', opacity: 1 }}
          exit={
            canAnimate
              ? {
                  height: 0,
                  opacity: collapseMotion === 'scroll-up' ? 0.65 : 0
                }
              : undefined
          }
          transition={{ duration: canAnimate ? duration : 0, ease: 'easeOut' }}
          className={className}
          style={{ overflow: 'hidden' }}
          onAnimationComplete={() => notifyExecutionResize(panelRef.current)}
        >
          <motion.div
            ref={contentRef}
            className={contentClassName}
            initial={false}
            animate={{ y: 0, opacity: 1 }}
            exit={
              canAnimate && collapseMotion === 'scroll-up' ? { y: '-18%', opacity: 0 } : undefined
            }
            transition={{ duration: canAnimate ? duration : 0, ease: 'easeOut' }}
          >
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

/** Keep a live thinking block mounted until its scroll-up exit animation has completed. */
export function ScrollUpExitItem({ children }: { children: React.ReactNode }): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      initial={false}
      animate={{ y: 0, opacity: 1 }}
      exit={reduceMotion ? undefined : { y: '-18%', opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  )
}
