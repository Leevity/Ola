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

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={reduceMotion ? false : { height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : duration, ease: 'easeOut' }}
          className={className}
        >
          <div className={contentClassName}>{children}</div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
