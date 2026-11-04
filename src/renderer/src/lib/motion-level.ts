import { OLA_DESIGN } from './ola-design-tokens'

/**
 * The ladder is owned by the design tokens; `scripts/sync-ola-design.mjs`
 * rejects any other ordering so this list stays the single source of truth.
 */
export const MOTION_LEVELS = ['full', 'reduced', 'off'] as const
export type MotionLevel = (typeof MOTION_LEVELS)[number]
export const DEFAULT_MOTION_LEVEL: MotionLevel = 'full'

export function isMotionLevel(value: unknown): value is MotionLevel {
  return typeof value === 'string' && (MOTION_LEVELS as readonly string[]).includes(value)
}

export function normalizeMotionLevel(value: unknown): MotionLevel {
  return isMotionLevel(value) ? value : DEFAULT_MOTION_LEVEL
}

/**
 * The OS preference is a floor, never a ceiling: a user who asked for full motion
 * still gets reduced motion when the system asks for it, while an explicit
 * `reduced`/`off` choice is never raised back up.
 */
export function resolveMotionLevel(
  preferred: MotionLevel,
  systemPrefersReduced: boolean
): MotionLevel {
  if (preferred === 'off') return 'off'
  if (systemPrefersReduced) return 'reduced'
  return preferred
}

export interface MotionProfile {
  /** Opacity fades survive a reduction; they are the cheapest way to keep a change legible. */
  opacity: boolean
  /** Sliding, scaling, and height changes are what `reduced` drops. */
  transform: boolean
  /** Milliseconds for micro feedback such as hover or focus. */
  feedbackMs: number
  /** Milliseconds for structural transitions. */
  transitionMs: number
}

export function getMotionProfile(level: MotionLevel): MotionProfile {
  const { feedback, transition } = OLA_DESIGN.motion
  if (level === 'off') {
    return { opacity: false, transform: false, feedbackMs: 0, transitionMs: 0 }
  }
  if (level === 'reduced') {
    return { opacity: true, transform: false, feedbackMs: feedback, transitionMs: feedback }
  }
  return { opacity: true, transform: true, feedbackMs: feedback, transitionMs: transition }
}

/** Transition durations are expressed in seconds for `motion/react`. */
export function motionSeconds(
  level: MotionLevel,
  kind: 'feedback' | 'transition' = 'transition'
): number {
  const { feedbackMs, transitionMs } = getMotionProfile(level)
  return (kind === 'feedback' ? feedbackMs : transitionMs) / 1000
}
