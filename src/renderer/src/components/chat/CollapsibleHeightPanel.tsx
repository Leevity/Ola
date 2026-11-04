import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useMotionProfile } from '@renderer/hooks/use-motion-level'

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
  // `useMotionProfile` folds in the system `prefers-reduced-motion` preference, so a
  // height transition only runs at `full`; `reduced` keeps the fade but snaps the height.
  const profile = useMotionProfile()
  const contentRef = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = React.useState(0)

  const canAnimate = enabled && profile.transform
  const canFade = enabled && profile.opacity
  const fadeSeconds = profile.feedbackMs / 1000

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
          initial={canAnimate ? { height: 0, opacity: 0 } : canFade ? { opacity: 0 } : false}
          animate={{ height: canAnimate ? contentHeight : 'auto', opacity: 1 }}
          exit={
            canAnimate
              ? {
                  height: 0,
                  opacity: collapseMotion === 'scroll-up' ? 0.65 : 0
                }
              : canFade
                ? { opacity: 0 }
                : undefined
          }
          transition={{
            duration: canAnimate ? duration : canFade ? fadeSeconds : 0,
            ease: 'easeOut'
          }}
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
              canAnimate && collapseMotion === 'scroll-up'
                ? { y: '-18%', opacity: 0 }
                : canFade
                  ? { opacity: 0 }
                  : undefined
            }
            transition={{
              duration: canAnimate ? duration : canFade ? fadeSeconds : 0,
              ease: 'easeOut'
            }}
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
  const profile = useMotionProfile()
  const slide = profile.transform
  const fade = profile.opacity
  return (
    <motion.div
      initial={false}
      animate={{ y: 0, opacity: 1 }}
      exit={slide ? { y: '-18%', opacity: 0 } : fade ? { opacity: 0 } : undefined}
      transition={{
        duration: slide ? 0.2 : fade ? profile.feedbackMs / 1000 : 0,
        ease: 'easeOut'
      }}
    >
      {children}
    </motion.div>
  )
}
