import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { ipcStorage } from '@renderer/lib/ipc/ipc-storage'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { PET_ACTION_STANDARDS, getPetLevel } from '@renderer/lib/pet/pet-standards'
import { usePetWalletStore } from './pet-wallet-store'
export { getGrowthForLevel, getLevelProgress, getPetLevel } from '@renderer/lib/pet/pet-standards'

/**
 * Visual archetype — controls which sprite set CapybaraSprite falls back to
 * when no custom skin is active. `aniya` is the default Ola companion.
 */
export type PetKind = 'aniya' | 'penguin' | 'custom'

export type PetAwayKind = 'work' | 'study'

export interface PetAwayTask {
  kind: PetAwayKind
  startedAt: number
  endsAt: number
}

export type PetActionResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'coins'
        | 'full'
        | 'clean'
        | 'hungry'
        | 'level'
        | 'busy'
        | 'sleeping'
        | 'max'
        | 'archived'
    }

export interface PetAwayReward {
  kind: PetAwayKind
  coins: number
  growth: number
}

/** Per-pet experience log entry. Premium multiplier is gone — every model
 *  earns the same XP rate (1 XP per 1,000 tokens). */
export interface PetExpLogEntry {
  id: string
  at: number
  model: string
  tokens: number
  exp: number
}

export type PetProactiveFreq = 'low' | 'medium' | 'high'

/**
 * TTS transport: 'speech' = OpenAI POST /audio/speech; 'chat' = chat/completions
 * with an audio-capable model (Xiaomi MiMo TTS style); 'auto' guesses from the
 * model id.
 */
export type PetVoiceMode = 'auto' | 'speech' | 'chat'

/** Timed proactive chats per day for each frequency setting. */
export const PET_PROACTIVE_DAILY_CAP: Record<PetProactiveFreq, number> = {
  low: 1,
  medium: 2,
  high: 4
}

export interface PetAgentConfig {
  providerId: string | null
  modelId: string | null
  /** Empty string means the built-in prompt is used. */
  systemPrompt: string
  projectId: string | null
  /** Denormalized so the standalone pet window doesn't need the chat store. */
  projectName: string | null
  projectFolder: string | null
  /** Master switch for all LLM-generated proactive speech. Default off. */
  proactive: boolean
  proactiveFreq: PetProactiveFreq
  /** Quiet hours [start, end) in local hours; equal values disable them. */
  quietStart: number
  quietEnd: number
  /** Voice playback for the pet's AI replies. Default off. */
  voiceEnabled: boolean
  voiceProviderId: string | null
  voiceModelId: string | null
  /** Voice/timbre id; empty means the endpoint's default. */
  voice: string
  voiceMode: PetVoiceMode
  /** Optional style instruction passed to the TTS call. */
  voiceInstruction: string
  /**
   * Optional MiMo audio tag(s) prepended to the spoken text as `(tag)` —
   * dialects/emotions like 粤语、撒娇、耳语. Ignored for non-MiMo models.
   */
  voiceTag: string
}

export interface PetExpState {
  totalExp: number
  totalTokens: number
  log: PetExpLogEntry[]
}

export interface PetPosition {
  x: number
  y: number
}

/** A single adoptable pet — its state, agent config, and exp log all live here. */
export interface Pet {
  id: string
  name: string
  kind: PetKind
  /** Built-in default pets (Aniya) cannot be archived or deleted. User-adopted
   *  pets always have this set to false. */
  isDefault: boolean
  createdAt: number
  archivedAt: number | null
  /** Whether the pet currently shows on the desktop window. */
  enabled: boolean

  hunger: number
  cleanliness: number
  mood: number
  /** Reward growth (work/study). Token exp lives in `exp.totalExp`. */
  growth: number
  coins: number
  sleeping: boolean
  awayTask: PetAwayTask | null
  lastTickAt: number
  adoptedAt: number
  /** Largest companionship milestone (in days) already celebrated. */
  lastMilestoneDays: number
  /** Local date (YYYY-MM-DD) the proactive counter belongs to. */
  proactiveDate: string
  /** Timed proactive chats fired on proactiveDate. */
  proactiveCount: number
  lastProactiveAt: number
  /** How much of totalExp has already been converted into coins. */
  coinCreditedExp: number
  /** Local date (YYYY-MM-DD) the daily check-in bonus was last claimed. */
  lastDailyBonusDate: string

  /** Position on the desktop window (when `enabled`); null = default placement. */
  position: PetPosition | null

  /** Active skin (directory name under ~/.ola/pets). */
  skinId: string | null

  /** Per-pet agent config. */
  agent: PetAgentConfig

  /** Per-pet experience ledger. */
  exp: PetExpState
}

export interface PetSkin {
  /** Directory name under ~/.ola/pets — doubles as the skin id. */
  id: string
  name: string
  path: string
  /** True for built-in skins installed at first run; false for AI / user-created. */
  builtin: boolean
  subject?: string
  modelId?: string
  createdAt?: number
  /** pose -> absolute file path of `<pose>.png` inside the skin directory */
  poses: Partial<Record<string, string>>
}

/** Cap for simultaneous desktop pets — protects the host from runaway sprite counts. */
export const PET_DESKTOP_LIMIT = 3

// ===== Tunables (kept identical to the legacy single-pet store) =====

export const PET_TICK_MS = 30_000

export const WORK_MIN_LEVEL = PET_ACTION_STANDARDS.work.unlockLevel
export const STUDY_MIN_LEVEL = PET_ACTION_STANDARDS.study.unlockLevel
export const SOAK_MIN_LEVEL = PET_ACTION_STANDARDS.soak.unlockLevel
export const WORK_DURATION_MS = 30 * 60_000
export const STUDY_DURATION_MS = 20 * 60_000
export const WORK_REWARD_COINS = 60
export const WORK_REWARD_GROWTH = 30
export const STUDY_REWARD_GROWTH = 240
export const FEED_COST = 10
export const BATHE_COST = 6
export const SOAK_COST = 15
export const STUDY_COST = 20
export const DAILY_BONUS_COINS = 20
/** Cap for the one-time retroactive coin grant when upgrading mid-progress. */
export const RETRO_COIN_CAP = 200

/** Reward growth + token exp — the value levels derive from. */
export function getCombinedGrowth(pet: Pick<Pet, 'growth' | 'exp'>): number {
  return pet.growth + pet.exp.totalExp
}

export function localDateKey(now = Date.now()): string {
  const d = new Date(now)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** Timed proactive chats already fired today (rolls over at local midnight). */
export function getProactiveCountToday(pet: Pick<Pet, 'proactiveDate' | 'proactiveCount'>): number {
  return pet.proactiveDate === localDateKey() ? pet.proactiveCount : 0
}

export function isInQuietHours(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false
  // Range may wrap midnight, e.g. 22 -> 9.
  return quietStart < quietEnd
    ? hour >= quietStart && hour < quietEnd
    : hour >= quietStart || hour < quietEnd
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value))
}

// Per-minute rates. Growth is NOT time-based: experience comes from token
// usage (pet.exp.totalExp) plus work/study rewards.
function applyDecay(pet: Pet, elapsedMs: number): Partial<Pet> {
  const minutes = Math.min(elapsedMs, 24 * 60 * 60_000) / 60_000
  if (minutes <= 0) return {}

  const restFactor = pet.sleeping ? 0.4 : pet.awayTask ? 0.5 : 1
  const hunger = clamp(pet.hunger - 0.8 * restFactor * minutes)
  const cleanliness = clamp(pet.cleanliness - 0.5 * restFactor * minutes)

  const uncomfortable = hunger < 30 || cleanliness < 30
  const moodDelta = uncomfortable ? -1.2 * minutes : 0.6 * minutes
  const mood = clamp(pet.mood + moodDelta)

  return { hunger, cleanliness, mood }
}

function defaultAgentConfig(): PetAgentConfig {
  return {
    providerId: null,
    modelId: null,
    systemPrompt: '',
    projectId: null,
    projectName: null,
    projectFolder: null,
    proactive: false,
    proactiveFreq: 'low',
    quietStart: 22,
    quietEnd: 9,
    voiceEnabled: false,
    voiceProviderId: null,
    voiceModelId: null,
    voice: '',
    voiceMode: 'auto',
    voiceInstruction: '',
    voiceTag: ''
  }
}

function emptyExp(): PetExpState {
  return { totalExp: 0, totalTokens: 0, log: [] }
}

export interface CreatePetInput {
  name: string
  description?: string
  persona?: string
  kind?: PetKind
  skinId?: string | null
  /** New pets stay off the desktop unless the caller explicitly enables them. */
  enabled?: boolean
  /** True for the built-in companion (Aniya). Defaults to false. */
  isDefault?: boolean
  /** Optional initial values used by "copy pet"; exp and away tasks are intentionally separate. */
  initialState?: Partial<
    Pick<
      Pet,
      | 'hunger'
      | 'cleanliness'
      | 'mood'
      | 'growth'
      | 'coins'
      | 'sleeping'
      | 'coinCreditedExp'
      | 'lastDailyBonusDate'
    >
  >
  /** Optional pre-seeded agent config (used by migration). */
  agent?: Partial<PetAgentConfig>
  /** Optional pre-seeded exp state (used by migration). */
  exp?: PetExpState
}

function freshPet(input: CreatePetInput, now: number): Pet {
  const kind: PetKind = input.kind ?? 'aniya'
  return {
    id: crypto.randomUUID(),
    name: input.name.trim() || 'Pet',
    kind,
    isDefault: input.isDefault === true,
    createdAt: now,
    archivedAt: null,
    enabled: input.enabled === true,

    hunger: input.initialState?.hunger ?? 80,
    cleanliness: input.initialState?.cleanliness ?? 80,
    mood: input.initialState?.mood ?? 70,
    growth: input.initialState?.growth ?? 0,
    coins: input.initialState?.coins ?? 120,
    sleeping: input.initialState?.sleeping ?? false,
    awayTask: null,
    lastTickAt: now,
    adoptedAt: now,
    lastMilestoneDays: 0,
    proactiveDate: '',
    proactiveCount: 0,
    lastProactiveAt: 0,
    coinCreditedExp: input.initialState?.coinCreditedExp ?? 0,
    lastDailyBonusDate: input.initialState?.lastDailyBonusDate ?? '',

    position: null,
    skinId: input.skinId ?? null,

    agent: {
      ...defaultAgentConfig(),
      ...(input.persona ? { systemPrompt: input.persona } : {}),
      ...(input.agent ?? {})
    },
    exp: input.exp ?? emptyExp()
  }
}

// =====================================================================
// Pets collection store
// =====================================================================

interface PetsCollectionState {
  pets: Pet[]
  /** Pets that are candidates to be shown on the desktop window (cap = PET_DESKTOP_LIMIT). */
  enabledIds: string[]
  /** Which enabled pet is actually on the desktop right now. Always null or in enabledIds. */
  activeOnDesktopId: string | null
  /** Default selection (most recently created/edited pet). */
  activePetId: string | null
}

interface PetsCollectionActions {
  /** Replace the entire collection (used by migration). */
  hydrate: (pets: Pet[]) => void
  /** Insert a new pet. Pets are desktop-disabled unless input.enabled is true. */
  createPet: (input: CreatePetInput) => Pet
  /** Mutate a single pet; no-op if the id is unknown. */
  updatePet: (id: string, patch: Partial<Pet>) => void
  /** Rename a pet in one line — used by the editor dialog's name field. */
  renamePet: (id: string, name: string) => void
  /** Soft-delete: hide everywhere, keep data. */
  archivePet: (id: string) => void
  /** Permanently remove from disk + memory. */
  deletePet: (id: string) => void
  /** Toggle a pet's presence on the desktop (caps at PET_DESKTOP_LIMIT). */
  setEnabled: (id: string, enabled: boolean) => boolean
  /** Master "show desktop companions" is off — force-disable every pet and
   *  clear the focus. The user's per-card switch positions are preserved
   *  (call setEnabled again to re-enable), but nothing is on the desktop. */
  clearAllEnabled: () => void
  /** Set which enabled pet is actually showing on the desktop window right now. */
  setActiveOnDesktop: (id: string | null) => void
  /** Mutate the per-pet agent config. */
  setPetAgent: (id: string, patch: Partial<PetAgentConfig>) => void
  /** Apply a skin id to a single pet. */
  setPetSkin: (id: string, skinId: string | null) => void
  /** Tick all enabled pets in a single dispatch. */
  tickAll: (now?: number) => void
  /** Apply a one-time per-pet action; returns the action result. */
  actOnPet: (id: string, action: PetActionName) => PetActionResult
  /** Record an XP gain against a single pet. */
  recordExp: (id: string, entry: PetExpLogEntry) => void
}

export type PetActionName =
  | 'feed'
  | 'bathe'
  | 'soak'
  | 'play'
  | 'toggleSleep'
  | 'startWork'
  | 'startStudy'
  | 'resolveAwayTask'
  | 'petted'
  | 'markMilestone'
  | 'recordProactive'
  | 'creditExpCoins'
  | 'claimDailyBonus'
  | 'addCoins'

export type PetsStore = PetsCollectionState & PetsCollectionActions

/**
 * Resolve a Pet instance for the given id. Falls back to the active pet,
 * then to the first enabled pet, then to the first pet in the collection.
 * Used widely by pet lib code that doesn't want to repeat the lookup chain.
 */
export function resolvePet(petId?: string | null): Pet | null {
  const state = usePetsStore.getState()
  if (petId) {
    const found = state.pets.find((pet) => pet.id === petId)
    if (found) return found
  }
  if (state.activePetId) {
    const found = state.pets.find((pet) => pet.id === state.activePetId)
    if (found) return found
  }
  const enabledId = state.enabledIds[0]
  if (enabledId) {
    const found = state.pets.find((pet) => pet.id === enabledId)
    if (found) return found
  }
  return state.pets[0] ?? null
}

function findPet(state: PetsCollectionState, id: string): Pet | undefined {
  return state.pets.find((pet) => pet.id === id)
}

function withPet(
  state: PetsCollectionState,
  id: string,
  patcher: (pet: Pet) => Pet
): { pets: Pet[]; activePetId: string | null } {
  let nextActive = state.activePetId
  const pets = state.pets.map((pet) => {
    if (pet.id !== id) return pet
    const next = patcher(pet)
    if (next.archivedAt !== null && state.activePetId === id) {
      nextActive = null
    }
    return next
  })
  return { pets, activePetId: nextActive }
}

function act(pet: Pet, action: PetActionName, now: number): { pet: Pet; result: PetActionResult } {
  switch (action) {
    case 'feed': {
      if (pet.archivedAt !== null) return { pet, result: { ok: false, reason: 'archived' } }
      if (pet.awayTask) return { pet, result: { ok: false, reason: 'busy' } }
      if (pet.sleeping) return { pet, result: { ok: false, reason: 'sleeping' } }
      if (pet.hunger >= 95) return { pet, result: { ok: false, reason: 'full' } }
      if (!usePetWalletStore.getState().spendCoins(FEED_COST))
        return { pet, result: { ok: false, reason: 'coins' } }
      return {
        pet: {
          ...pet,
          hunger: clamp(pet.hunger + 35),
          mood: clamp(pet.mood + 2)
        },
        result: { ok: true }
      }
    }
    case 'bathe': {
      if (pet.archivedAt !== null) return { pet, result: { ok: false, reason: 'archived' } }
      if (pet.awayTask) return { pet, result: { ok: false, reason: 'busy' } }
      if (pet.sleeping) return { pet, result: { ok: false, reason: 'sleeping' } }
      if (pet.cleanliness >= 95) return { pet, result: { ok: false, reason: 'clean' } }
      if (!usePetWalletStore.getState().spendCoins(BATHE_COST))
        return { pet, result: { ok: false, reason: 'coins' } }
      return {
        pet: {
          ...pet,
          cleanliness: clamp(pet.cleanliness + 45),
          mood: clamp(pet.mood + 1)
        },
        result: { ok: true }
      }
    }
    case 'soak': {
      if (pet.archivedAt !== null) return { pet, result: { ok: false, reason: 'archived' } }
      if (pet.awayTask) return { pet, result: { ok: false, reason: 'busy' } }
      if (pet.sleeping) return { pet, result: { ok: false, reason: 'sleeping' } }
      if (getPetLevel(getCombinedGrowth(pet)) < SOAK_MIN_LEVEL)
        return { pet, result: { ok: false, reason: 'level' } }
      if (!usePetWalletStore.getState().spendCoins(SOAK_COST))
        return { pet, result: { ok: false, reason: 'coins' } }
      return {
        pet: {
          ...pet,
          cleanliness: clamp(pet.cleanliness + 30),
          mood: clamp(pet.mood + 28)
        },
        result: { ok: true }
      }
    }
    case 'play': {
      if (pet.archivedAt !== null) return { pet, result: { ok: false, reason: 'archived' } }
      if (pet.awayTask) return { pet, result: { ok: false, reason: 'busy' } }
      if (pet.sleeping) return { pet, result: { ok: false, reason: 'sleeping' } }
      if (pet.hunger < 10) return { pet, result: { ok: false, reason: 'hungry' } }
      return {
        pet: {
          ...pet,
          mood: clamp(pet.mood + 18),
          hunger: clamp(pet.hunger - 6),
          cleanliness: clamp(pet.cleanliness - 4)
        },
        result: { ok: true }
      }
    }
    case 'toggleSleep': {
      if (pet.archivedAt !== null) return { pet, result: { ok: false, reason: 'archived' } }
      if (pet.awayTask) return { pet, result: { ok: false, reason: 'busy' } }
      return { pet: { ...pet, sleeping: !pet.sleeping }, result: { ok: true } }
    }
    case 'startWork': {
      if (pet.archivedAt !== null) return { pet, result: { ok: false, reason: 'archived' } }
      if (pet.awayTask) return { pet, result: { ok: false, reason: 'busy' } }
      if (getPetLevel(getCombinedGrowth(pet)) < WORK_MIN_LEVEL)
        return { pet, result: { ok: false, reason: 'level' } }
      if (pet.hunger < 20) return { pet, result: { ok: false, reason: 'hungry' } }
      return {
        pet: {
          ...pet,
          sleeping: false,
          awayTask: { kind: 'work', startedAt: now, endsAt: now + WORK_DURATION_MS }
        },
        result: { ok: true }
      }
    }
    case 'startStudy': {
      if (pet.archivedAt !== null) return { pet, result: { ok: false, reason: 'archived' } }
      if (pet.awayTask) return { pet, result: { ok: false, reason: 'busy' } }
      if (getPetLevel(getCombinedGrowth(pet)) < STUDY_MIN_LEVEL)
        return { pet, result: { ok: false, reason: 'level' } }
      if (!usePetWalletStore.getState().spendCoins(STUDY_COST))
        return { pet, result: { ok: false, reason: 'coins' } }
      if (pet.hunger < 20) return { pet, result: { ok: false, reason: 'hungry' } }
      return {
        pet: {
          ...pet,
          sleeping: false,
          awayTask: { kind: 'study', startedAt: now, endsAt: now + STUDY_DURATION_MS }
        },
        result: { ok: true }
      }
    }
    case 'resolveAwayTask': {
      if (!pet.awayTask || now < pet.awayTask.endsAt)
        return { pet, result: { ok: false, reason: 'busy' } }
      const reward: PetAwayReward =
        pet.awayTask.kind === 'work'
          ? { kind: 'work', coins: WORK_REWARD_COINS, growth: WORK_REWARD_GROWTH }
          : { kind: 'study', coins: 0, growth: STUDY_REWARD_GROWTH }
      usePetWalletStore.getState().addCoins(reward.coins)
      return {
        pet: {
          ...pet,
          awayTask: null,
          growth: pet.growth + reward.growth,
          hunger: clamp(pet.hunger - 10),
          cleanliness: clamp(pet.cleanliness - 8)
        },
        result: { ok: true }
      }
    }
    case 'petted': {
      if (pet.sleeping || pet.awayTask) return { pet, result: { ok: false, reason: 'busy' } }
      return { pet: { ...pet, mood: clamp(pet.mood + 3) }, result: { ok: true } }
    }
    case 'markMilestone': {
      // No-op signature-only — caller must provide days via updatePet.
      return { pet, result: { ok: true } }
    }
    case 'recordProactive': {
      const today = localDateKey(now)
      return {
        pet: {
          ...pet,
          proactiveDate: today,
          proactiveCount: pet.proactiveDate === today ? pet.proactiveCount + 1 : 1,
          lastProactiveAt: now
        },
        result: { ok: true }
      }
    }
    case 'creditExpCoins': {
      const total = pet.exp.totalExp
      if (total <= pet.coinCreditedExp) return { pet, result: { ok: false, reason: 'full' } }
      const delta = total - pet.coinCreditedExp
      const credit = pet.coinCreditedExp === 0 ? Math.min(delta, RETRO_COIN_CAP) : delta
      usePetWalletStore.getState().addCoins(credit)
      return {
        pet: {
          ...pet,
          coinCreditedExp: total
        },
        result: { ok: true }
      }
    }
    case 'claimDailyBonus': {
      const today = localDateKey(now)
      if (pet.lastDailyBonusDate === today) return { pet, result: { ok: false, reason: 'full' } }
      usePetWalletStore.getState().addCoins(DAILY_BONUS_COINS)
      return {
        pet: {
          ...pet,
          lastDailyBonusDate: today
        },
        result: { ok: true }
      }
    }
    case 'addCoins': {
      // Caller passes the amount via updatePet — this branch keeps the union exhaustive.
      return { pet, result: { ok: true } }
    }
  }
}

export const usePetsStore = create<PetsStore>()(
  persist(
    (set, get) => ({
      pets: [],
      enabledIds: [],
      activePetId: null,
      activeOnDesktopId: null,

      hydrate: (pets) => {
        const enabledIds = pets
          .filter((pet) => pet.enabled && pet.archivedAt === null)
          .map((pet) => pet.id)
        const activePetId = pets.length > 0 ? (pets[pets.length - 1]?.id ?? null) : null
        // First non-archived enabled pet takes the desktop on a fresh
        // migration — without this, the pet window would launch empty.
        const activeOnDesktopId = enabledIds[0] ?? null
        set({ pets, enabledIds, activePetId, activeOnDesktopId })
      },

      createPet: (input) => {
        const pet = freshPet(input, Date.now())
        set((state) => {
          const enabled = pet.enabled && state.enabledIds.length < PET_DESKTOP_LIMIT
          const nextEnabledIds = enabled ? [...state.enabledIds, pet.id] : state.enabledIds
          return {
            pets: [...state.pets, pet],
            enabledIds: nextEnabledIds,
            activePetId: pet.id,
            activeOnDesktopId:
              state.activeOnDesktopId === null && enabled ? pet.id : state.activeOnDesktopId
          }
        })
        void ipcClient.invoke('pet:create', { pet }).catch((err) => {
          console.error('[Pets] main create failed:', err)
        })
        return pet
      },

      updatePet: (id, patch) => {
        set((state) => {
          const updated = withPet(state, id, (pet) => ({ ...pet, ...patch }))
          return updated
        })
        void ipcClient.invoke('pet:update', { id, patch }).catch((err) => {
          console.error('[Pets] main update failed:', err)
        })
      },

      renamePet: (id, name) => {
        const trimmed = name.trim()
        if (!trimmed) return
        get().updatePet(id, { name: trimmed })
      },

      archivePet: (id) => {
        const pet = findPet(get(), id)
        if (pet?.isDefault) return
        get().updatePet(id, { archivedAt: Date.now() })
        set((state) => ({
          enabledIds: state.enabledIds.filter((x) => x !== id),
          activeOnDesktopId: state.activeOnDesktopId === id ? null : state.activeOnDesktopId
        }))
      },

      deletePet: (id) => {
        const pet = findPet(get(), id)
        if (pet?.isDefault) return
        set((state) => ({
          pets: state.pets.filter((pet) => pet.id !== id),
          enabledIds: state.enabledIds.filter((x) => x !== id),
          activePetId: state.activePetId === id ? null : state.activePetId,
          activeOnDesktopId: state.activeOnDesktopId === id ? null : state.activeOnDesktopId
        }))
        void ipcClient
          .invoke('pet:sync', { kind: 'pets', payload: { deletedId: id } })
          .catch((err) => {
            console.error('[Pets] main delete sync failed:', err)
          })
      },

      setEnabled: (id, enabled) => {
        const state = get()
        const pet = findPet(state, id)
        if (!pet || pet.archivedAt !== null) return false
        const has = state.enabledIds.includes(id)
        if (enabled && !has && state.enabledIds.length >= PET_DESKTOP_LIMIT) return false
        set((state) => {
          const newEnabledIds = enabled
            ? state.enabledIds.includes(id)
              ? state.enabledIds
              : [...state.enabledIds, id]
            : state.enabledIds.filter((x) => x !== id)
          // If the pet was the active focus and we're turning it off, clear
          // the focus so the next time the window opens nothing renders
          // for the now-disabled pet. If we're turning it on, only adopt
          // it as focus when there's no current focus.
          let newActive = state.activeOnDesktopId
          if (!enabled && newActive === id) {
            newActive = null
          } else if (enabled && newActive === null) {
            newActive = id
          }
          return {
            pets: state.pets.map((p) => (p.id === id ? { ...p, enabled } : p)),
            enabledIds: newEnabledIds,
            activeOnDesktopId: newActive
          }
        })
        void ipcClient.invoke('pet:update', { id, patch: { enabled } }).catch(() => undefined)
        return true
      },

      clearAllEnabled: () => {
        // Wipe both `pet.enabled` and the enabledIds set so the desktop
        // window renders nothing and every per-card switch flips off.
        // The user re-enables pets individually via the cards.
        set((state) => ({
          pets: state.pets.map((p) => (p.archivedAt === null ? { ...p, enabled: false } : p)),
          enabledIds: [],
          activeOnDesktopId: null
        }))
      },

      setActiveOnDesktop: (id: string | null) => {
        const state = get()
        if (id !== null) {
          // Must be enabled and not archived to show on the desktop.
          const pet = state.pets.find((p) => p.id === id)
          if (!pet || pet.archivedAt !== null) return
          if (!state.enabledIds.includes(id)) return
        }
        set({ activeOnDesktopId: id })
      },

      setPetSkin: (id, skinId) => {
        get().updatePet(id, { skinId })
        void ipcClient
          .invoke('pet:sync', { kind: 'skin', payload: { petId: id, skinId } })
          .catch(() => undefined)
      },

      setPetAgent: (id, patch) => {
        set((state) => withPet(state, id, (pet) => ({ ...pet, agent: { ...pet.agent, ...patch } })))
      },

      tickAll: (now = Date.now()) => {
        set((state) => {
          let dirty = false
          const pets = state.pets.map((pet) => {
            const elapsed = now - pet.lastTickAt
            if (elapsed < 1000) return pet
            dirty = true
            return { ...pet, ...applyDecay(pet, elapsed), lastTickAt: now }
          })
          return dirty ? { pets } : {}
        })
      },

      actOnPet: (id, action) => {
        const state = get()
        const pet = findPet(state, id)
        if (!pet) return { ok: false, reason: 'archived' }
        const { pet: next, result } = act(pet, action, Date.now())
        if (next !== pet) {
          set((s) => withPet(s, id, () => next))
          void ipcClient.invoke('pet:update', { id, patch: next }).catch(() => undefined)
        }
        return result
      },

      recordExp: (id, entry) => {
        set((state) =>
          withPet(state, id, (pet) => {
            const gainedExp = Math.max(0, entry.exp)
            const totalExp = Math.round((pet.exp.totalExp + gainedExp) * 100) / 100
            return {
              ...pet,
              coinCreditedExp: pet.coinCreditedExp + gainedExp,
              exp: {
                totalExp,
                totalTokens: pet.exp.totalTokens + (entry.tokens > 0 ? entry.tokens : 0),
                log: [entry, ...pet.exp.log].slice(0, 100)
              }
            }
          })
        )
      }
    }),
    {
      name: 'ola-pets-v1',
      storage: createJSONStorage(() => ipcStorage),
      version: 1,
      partialize: (state) => ({
        pets: state.pets,
        enabledIds: state.enabledIds,
        activePetId: state.activePetId,
        activeOnDesktopId: state.activeOnDesktopId
      })
    }
  )
)

// Cross-window rehydrate: when settings save, the main process broadcasts
// `pet:sync-event { kind: 'pets' }` and we refresh from disk so a separately
// loaded PetWindow stays in sync.
//
// Important: when we receive our own broadcast back from main (the `pet:update`
// IPC fires synchronously after each `actOnPet` call), the in-memory state is
// already correct. Rehydrating from disk at that point is a race: if the
// renderer-side `ipcStorage.setItem` for `ola-pets-v1` is still in flight,
// rehydrate pulls a stale snapshot and clobbers the freshly-written patch
// back to 0. Instead, prefer the patch carried in the broadcast itself; only
// fall back to rehydrate when no patch is supplied (e.g. create / archive
// flows that involve a refetch).
ipcClient.on('pet:sync-event', (payload) => {
  const event = payload as {
    kind?: string
    action?: string
    id?: string
    patch?: Record<string, unknown>
  } | null
  if (!event) return
  if (event.kind === 'exp') {
    void usePetsStore.persist.rehydrate()
    return
  }
  if (event.kind === 'pets') {
    if (event.action === 'update' && event.id && event.patch) {
      // Merge the patch in place — this round-trips back the pet state the
      // originator just wrote to disk, without forcing a rehydrate.
      usePetsStore.setState((state) => ({
        pets: state.pets.map((pet) => (pet.id === event.id ? { ...pet, ...event.patch } : pet))
      }))
    } else {
      void usePetsStore.persist.rehydrate()
    }
  }
})
