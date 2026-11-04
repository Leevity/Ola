import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MOTION_LEVEL,
  MOTION_LEVELS,
  getMotionProfile,
  isMotionLevel,
  motionSeconds,
  normalizeMotionLevel,
  resolveMotionLevel
} from '@renderer/lib/motion-level'
import { OLA_DESIGN } from '@renderer/lib/ola-design-tokens'

describe('motion level ladder', () => {
  it('is owned by the design tokens', () => {
    expect([...MOTION_LEVELS]).toEqual([...OLA_DESIGN.motion.levels])
    expect(MOTION_LEVELS).toEqual(['full', 'reduced', 'off'])
    expect(DEFAULT_MOTION_LEVEL).toBe('full')
  })

  it('narrows unknown values to the default instead of trusting them', () => {
    expect(isMotionLevel('reduced')).toBe(true)
    expect(isMotionLevel('sometimes')).toBe(false)
    expect(isMotionLevel(undefined)).toBe(false)
    expect(normalizeMotionLevel('off')).toBe('off')
    expect(normalizeMotionLevel('sometimes')).toBe(DEFAULT_MOTION_LEVEL)
    expect(normalizeMotionLevel(null)).toBe(DEFAULT_MOTION_LEVEL)
  })
})

describe('resolveMotionLevel', () => {
  it('lets the system preference lower full motion', () => {
    expect(resolveMotionLevel('full', true)).toBe('reduced')
    expect(resolveMotionLevel('full', false)).toBe('full')
  })

  it('never raises an explicit reduced or off choice', () => {
    expect(resolveMotionLevel('reduced', false)).toBe('reduced')
    expect(resolveMotionLevel('reduced', true)).toBe('reduced')
    expect(resolveMotionLevel('off', false)).toBe('off')
    expect(resolveMotionLevel('off', true)).toBe('off')
  })
})

describe('getMotionProfile', () => {
  it('keeps every transition at full', () => {
    expect(getMotionProfile('full')).toEqual({
      opacity: true,
      transform: true,
      feedbackMs: OLA_DESIGN.motion.feedback,
      transitionMs: OLA_DESIGN.motion.transition
    })
  })

  it('drops transforms but keeps fades at reduced', () => {
    expect(getMotionProfile('reduced')).toEqual({
      opacity: true,
      transform: false,
      feedbackMs: OLA_DESIGN.motion.feedback,
      transitionMs: OLA_DESIGN.motion.feedback
    })
  })

  it('zeroes every duration at off', () => {
    expect(getMotionProfile('off')).toEqual({
      opacity: false,
      transform: false,
      feedbackMs: 0,
      transitionMs: 0
    })
  })

  it('converts durations to seconds for motion/react', () => {
    expect(motionSeconds('full')).toBe(OLA_DESIGN.motion.transition / 1000)
    expect(motionSeconds('full', 'feedback')).toBe(OLA_DESIGN.motion.feedback / 1000)
    expect(motionSeconds('reduced')).toBe(OLA_DESIGN.motion.feedback / 1000)
    expect(motionSeconds('off')).toBe(0)
  })
})
