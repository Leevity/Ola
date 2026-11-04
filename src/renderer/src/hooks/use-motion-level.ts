import { useReducedMotion } from 'motion/react'
import { useSettingsStore } from '@renderer/stores/settings-store'
import {
  getMotionProfile,
  resolveMotionLevel,
  type MotionLevel,
  type MotionProfile
} from '@renderer/lib/motion-level'

/**
 * Effective motion level. The stored choice is the user's intent; the operating
 * system can only lower it, never raise it back.
 */
export function useMotionLevel(): MotionLevel {
  const stored = useSettingsStore((state) => state.motionLevel)
  const systemPrefersReduced = useReducedMotion()
  return resolveMotionLevel(stored, Boolean(systemPrefersReduced))
}

export function useMotionProfile(): MotionProfile {
  return getMotionProfile(useMotionLevel())
}
