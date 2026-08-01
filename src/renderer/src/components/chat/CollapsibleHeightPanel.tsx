import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

interface CollapsibleHeightPanelProps {
  open: boolean
  children: React.ReactNode
  className?: string
  contentClassName?: string
  duration?: number
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
  duration = 0.2
}: CollapsibleHeightPanelProps): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = React.useState(0)

  React.useLayoutEffect(() => {
    if (!open || !contentRef.current) return
    const content = contentRef.current
    const measure = (): void => {
      setContentHeight((previous) => {
        const next = content.getBoundingClientRect().height
        return Math.abs(previous - next) > 0.5 ? next : previous
      })
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
          initial={reduceMotion ? false : { height: 0, opacity: 0 }}
          animate={{ height: reduceMotion ? 'auto' : contentHeight, opacity: 1 }}
          exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : duration, ease: 'easeOut' }}
          className={className}
          style={{ overflow: 'hidden' }}
        >
          <div ref={contentRef} className={contentClassName}>
            {children}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
