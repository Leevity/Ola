import { PET_POSE_KEYS, type PetPoseKey } from './pet-pose-prompts'

export const PET_MAX_LEVEL = 10

export interface PetLevelRule {
  level: number
  requiredGrowth: number
  unlocks: string[]
}

export const PET_LEVELS: PetLevelRule[] = [
  { level: 1, requiredGrowth: 0, unlocks: ['basic'] },
  { level: 2, requiredGrowth: 5, unlocks: ['soak'] },
  { level: 3, requiredGrowth: 15, unlocks: ['beg'] },
  { level: 4, requiredGrowth: 35, unlocks: ['work'] },
  { level: 5, requiredGrowth: 70, unlocks: ['zen'] },
  { level: 6, requiredGrowth: 120, unlocks: ['study'] },
  { level: 7, requiredGrowth: 200, unlocks: ['swim'] },
  { level: 8, requiredGrowth: 320, unlocks: ['proactive-plus'] },
  { level: 9, requiredGrowth: 500, unlocks: ['advanced-emotion'] },
  { level: 10, requiredGrowth: 800, unlocks: ['mastery'] }
]

export type PetPoseRequirement = 'required' | 'recommended' | 'optional'

export interface PetPoseStandard {
  key: PetPoseKey
  unlockLevel: number
  requirement: PetPoseRequirement
  fallback: PetPoseKey
}

const POSE_STANDARD: Record<PetPoseKey, PetPoseStandard> = {
  idle: { key: 'idle', unlockLevel: 1, requirement: 'required', fallback: 'idle' },
  walk: { key: 'walk', unlockLevel: 1, requirement: 'required', fallback: 'idle' },
  sleep: { key: 'sleep', unlockLevel: 1, requirement: 'required', fallback: 'idle' },
  beg: { key: 'beg', unlockLevel: 3, requirement: 'recommended', fallback: 'idle' },
  eat: { key: 'eat', unlockLevel: 1, requirement: 'required', fallback: 'idle' },
  munch: { key: 'munch', unlockLevel: 1, requirement: 'recommended', fallback: 'eat' },
  bathe: { key: 'bathe', unlockLevel: 1, requirement: 'required', fallback: 'idle' },
  soak: { key: 'soak', unlockLevel: 2, requirement: 'recommended', fallback: 'bathe' },
  swim: { key: 'swim', unlockLevel: 7, requirement: 'optional', fallback: 'walk' },
  zen: { key: 'zen', unlockLevel: 5, requirement: 'recommended', fallback: 'idle' },
  play: { key: 'play', unlockLevel: 1, requirement: 'required', fallback: 'idle' },
  held: { key: 'held', unlockLevel: 1, requirement: 'required', fallback: 'idle' }
}

export const PET_POSE_STANDARDS = PET_POSE_KEYS.map((key) => POSE_STANDARD[key])

export type PetStandardAction =
  | 'feed'
  | 'bathe'
  | 'soak'
  | 'play'
  | 'sleep'
  | 'chat'
  | 'work'
  | 'study'
  | 'hide'
  | 'studio'

export interface PetActionStandard {
  key: PetStandardAction
  unlockLevel: number
  pose: PetPoseKey | null
  quick: boolean
}

export const PET_ACTION_STANDARDS: Record<PetStandardAction, PetActionStandard> = {
  feed: { key: 'feed', unlockLevel: 1, pose: 'eat', quick: true },
  bathe: { key: 'bathe', unlockLevel: 1, pose: 'bathe', quick: true },
  soak: { key: 'soak', unlockLevel: 2, pose: 'soak', quick: false },
  play: { key: 'play', unlockLevel: 1, pose: 'play', quick: true },
  sleep: { key: 'sleep', unlockLevel: 1, pose: 'sleep', quick: true },
  chat: { key: 'chat', unlockLevel: 1, pose: 'idle', quick: true },
  work: { key: 'work', unlockLevel: 4, pose: null, quick: false },
  study: { key: 'study', unlockLevel: 6, pose: 'zen', quick: false },
  hide: { key: 'hide', unlockLevel: 1, pose: null, quick: false },
  studio: { key: 'studio', unlockLevel: 1, pose: null, quick: false }
}

export const PET_QUICK_ACTIONS = Object.values(PET_ACTION_STANDARDS).filter((item) => item.quick)

export function getPetLevel(growth: number): number {
  const safeGrowth = Math.max(0, growth)
  let level = 1
  for (const rule of PET_LEVELS) {
    if (safeGrowth >= rule.requiredGrowth) level = rule.level
  }
  return Math.min(PET_MAX_LEVEL, level)
}

export function getGrowthForLevel(level: number): number {
  const clamped = Math.min(PET_MAX_LEVEL, Math.max(1, Math.floor(level)))
  return PET_LEVELS.find((rule) => rule.level === clamped)?.requiredGrowth ?? 0
}

export function getLevelProgress(growth: number): number {
  const level = getPetLevel(growth)
  if (level >= PET_MAX_LEVEL) return 1
  const current = getGrowthForLevel(level)
  const next = getGrowthForLevel(level + 1)
  return Math.min(1, Math.max(0, (growth - current) / (next - current)))
}

export function getNextLevelGrowth(growth: number): number {
  const level = getPetLevel(growth)
  return getGrowthForLevel(Math.min(PET_MAX_LEVEL, level + 1))
}

export function getUnlockedPoseStandards(level: number): PetPoseStandard[] {
  return PET_POSE_STANDARDS.filter((pose) => pose.unlockLevel <= level)
}

export function getUnlockedActionStandards(level: number): PetActionStandard[] {
  return Object.values(PET_ACTION_STANDARDS).filter((action) => action.unlockLevel <= level)
}
