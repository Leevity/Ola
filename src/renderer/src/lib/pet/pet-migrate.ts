/**
 * One-shot migration from the legacy single-pet persistence keys to the new
 * `ola-pets-v1` collection.
 *
 * Legacy keys (read once, then deleted):
 *  - ola-pet            (usePetStore — hunger/clean/mood/coins/sleeping/...)
 *  - ola-pet-agent      (usePetAgentStore — provider/model/prompt/voice...)
 *  - ola-pet-exp        (usePetExpStore — totalExp/totalTokens/log)
 *  - ola-pet-skins      (usePetSkinStore — activeSkinId + scanned skins)
 *
 * After migration a marker key `ola-pets-migrated-v1` is set so subsequent
 * boots skip the work. If anything goes wrong we leave the legacy keys in
 * place so the user can recover manually — migration is purely additive.
 */
import { ipcStorage } from '@renderer/lib/ipc/ipc-storage'
import {
  usePetsStore,
  type Pet,
  type PetAgentConfig,
  type PetExpState,
  type PetSkin
} from '@renderer/stores/pets-store'

const LEGACY_KEYS = ['ola-pet', 'ola-pet-agent', 'ola-pet-exp', 'ola-pet-skins'] as const

const MIGRATION_MARKER = 'ola-pets-migrated-v1'
const NEW_SKINS_KEY = 'ola-pet-skins-v1'

interface LegacyPersisted<T> {
  state?: T
  version?: number
}

interface LegacyPetState {
  name?: string
  hunger?: number
  cleanliness?: number
  mood?: number
  growth?: number
  coins?: number
  sleeping?: boolean
  awayTask?: Pet['awayTask']
  lastTickAt?: number
  adoptedAt?: number
  lastMilestoneDays?: number
  proactiveDate?: string
  proactiveCount?: number
  lastProactiveAt?: number
  coinCreditedExp?: number
  lastDailyBonusDate?: string
}

interface LegacyAgentState {
  providerId?: string | null
  modelId?: string | null
  systemPrompt?: string
  projectId?: string | null
  projectName?: string | null
  projectFolder?: string | null
  proactive?: boolean
  proactiveFreq?: PetAgentConfig['proactiveFreq']
  quietStart?: number
  quietEnd?: number
  voiceEnabled?: boolean
  voiceProviderId?: string | null
  voiceModelId?: string | null
  voice?: string
  voiceMode?: PetAgentConfig['voiceMode']
  voiceInstruction?: string
  voiceTag?: string
}

interface LegacyExpState {
  totalExp?: number
  totalTokens?: number
  log?: PetExpState['log']
}

interface LegacySkinState {
  activeSkinId?: string | null
}

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await ipcStorage.getItem(key)
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await ipcStorage.setItem(key, JSON.stringify(value))
}

async function removeKeys(keys: readonly string[]): Promise<void> {
  await Promise.all(
    keys.map((key) => {
      const p = ipcStorage.removeItem(key) as unknown as Promise<unknown>
      return p.catch(() => undefined)
    })
  )
}

function normalizeSkinId(id?: string | null): string | null {
  if (!id) return null
  return id === 'anya' ? 'aniya' : id
}

function defaultAgent(): PetAgentConfig {
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

function mergeAgent(legacy: LegacyAgentState | null | undefined): PetAgentConfig {
  const base = defaultAgent()
  if (!legacy) return base
  return {
    ...base,
    ...Object.fromEntries(Object.entries(legacy).filter(([, value]) => value !== undefined))
  } as PetAgentConfig
}

function mergeExp(legacy: LegacyExpState | null | undefined): PetExpState {
  return {
    totalExp: legacy?.totalExp ?? 0,
    totalTokens: legacy?.totalTokens ?? 0,
    log: Array.isArray(legacy?.log) ? (legacy?.log ?? []) : []
  }
}

interface MigrationResult {
  migrated: boolean
  reason?: string
  petId?: string
}

/**
 * Run the legacy → new migration exactly once. Safe to call from multiple
 * windows concurrently: each step is gated by reading the marker first.
 */
export async function runPetMigration(): Promise<MigrationResult> {
  const marker = await ipcStorage.getItem(MIGRATION_MARKER)

  // Rescue path: marker is set but the pets collection is empty. This can
  // happen if an earlier migration succeeded in memory but the
  // `ola-pets-v1` write lost the race against the marker write — the
  // classic "Aniya is on screen but missing from the list" bug. Drop the
  // marker and re-run so the seed is recreated and persisted.
  if (marker === '1') {
    try {
      const persisted = (
        await readJson<
          LegacyPersisted<{
            pets?: Pet[]
            enabledIds?: string[]
            activePetId?: string | null
            activeOnDesktopId?: string | null
          }>
        >('ola-pets-v1')
      )?.state
      if (!persisted || !Array.isArray(persisted.pets) || persisted.pets.length === 0) {
        await ipcStorage.removeItem(MIGRATION_MARKER)
        // fall through to the regular path
      } else {
        // Heal legacy shapes: rename the default pet to "阿尼娅" and make
        // sure the kind / isDefault flags match the current schema. Older
        // migration runs left the user's old Kapi name in place; we now
        // settle on "阿尼娅" as the canonical default name.
        const sourcePets = persisted.pets
        const cleaned = sourcePets.map((pet) =>
          pet.isDefault ? { ...pet, name: '阿尼娅', kind: 'aniya' as const, enabled: false } : pet
        )
        const dirty = cleaned.some((pet, i) => pet !== sourcePets[i])
        if (dirty) {
          const nextEnabledIds = cleaned
            .filter((p) => p.enabled && p.archivedAt === null)
            .map((p) => p.id)
          // The active-desktop focus only makes sense when its pet is in
          // enabledIds; otherwise the desktop window would render a
          // ghost of a pet the user already turned off.
          const persistedActive =
            persisted.activeOnDesktopId && nextEnabledIds.includes(persisted.activeOnDesktopId)
              ? persisted.activeOnDesktopId
              : null
          await writeJson('ola-pets-v1', {
            state: {
              pets: cleaned,
              enabledIds: nextEnabledIds,
              activePetId: persisted.activePetId ?? cleaned[0]?.id ?? null,
              activeOnDesktopId: persistedActive
            },
            version: 1
          })
          usePetsStore.setState({
            pets: cleaned,
            enabledIds: nextEnabledIds,
            activePetId: persisted.activePetId ?? cleaned[0]?.id ?? null,
            activeOnDesktopId: persistedActive
          })
        }
        return { migrated: false, reason: 'already-migrated' }
      }
    } catch {
      // Treat unreadable persisted state as missing and re-seed.
      await ipcStorage.removeItem(MIGRATION_MARKER)
    }
  }

  const [petRaw, agentRaw, expRaw, skinsRaw] = await Promise.all([
    readJson<LegacyPersisted<LegacyPetState>>('ola-pet'),
    readJson<LegacyPersisted<LegacyAgentState>>('ola-pet-agent'),
    readJson<LegacyPersisted<LegacyExpState>>('ola-pet-exp'),
    readJson<LegacyPersisted<LegacySkinState>>('ola-pet-skins')
  ])

  const legacyPet = petRaw?.state ?? null
  const legacyAgent = agentRaw?.state ?? null
  const legacyExp = expRaw?.state ?? null
  const legacySkin = skinsRaw?.state ?? null

  const now = Date.now()

  // First-time install: no legacy data, create the default Aniya so the
  // desktop window has someone to show from the very first launch.
  if (!legacyPet) {
    const seed: Pet = {
      id: crypto.randomUUID(),
      name: '阿尼娅',
      kind: 'aniya',
      isDefault: true,
      createdAt: now,
      archivedAt: null,
      // Aniya starts hidden: low-end devices shouldn't have a floating
      // pet render every time the app opens. The user can flip her on
      // (and the master "show desktop companions" switch) from settings.
      enabled: false,

      hunger: 80,
      cleanliness: 80,
      mood: 70,
      growth: 0,
      coins: 120,
      sleeping: false,
      awayTask: null,
      lastTickAt: now,
      adoptedAt: now,
      lastMilestoneDays: 0,
      proactiveDate: '',
      proactiveCount: 0,
      lastProactiveAt: 0,
      coinCreditedExp: 0,
      lastDailyBonusDate: '',

      position: null,
      skinId: 'aniya',

      agent: mergeAgent(legacyAgent),
      exp: mergeExp(legacyExp)
    }
    usePetsStore.getState().hydrate([seed])
    // Wait one microtask + small timeout so zustand persist has a chance to
    // write `ola-pets-v1` to ipcStorage. Without this, the next mount can
    // see the migration marker and skip the seed step before the persisted
    // blob has been written, which leaves the list empty until the user
    // touches the data.
    await new Promise((resolve) => setTimeout(resolve, 60))
    // Belt-and-suspenders: also write the partialize output ourselves so the
    // next `persist.rehydrate()` is guaranteed to find Aniya even if the
    // in-memory persist write raced ahead of the marker write.
    await writeJson('ola-pets-v1', {
      state: {
        pets: [seed],
        enabledIds: [],
        activePetId: seed.id,
        activeOnDesktopId: null
      },
      version: 1
    })
    await writeJson(MIGRATION_MARKER, '1')
    await writeJson(NEW_SKINS_KEY, {
      state: { activeSkinId: 'aniya', seeded: true },
      version: 1
    })
    await removeKeys(LEGACY_KEYS)
    return { migrated: true, petId: seed.id }
  }

  const petId = crypto.randomUUID()
  // Old legacy single-pet data always becomes the built-in Aniya — even if the
  // user named it "Kapi" or whatever, we keep their custom name (so they don't
  // lose renaming work) but flag it as the default pet so they can't delete it.
  // Migrations land the user back in the same state a fresh install
  // sees: Aniya is on the desktop by default.
  const migrated: Pet = {
    id: petId,
    name: legacyPet.name ?? '阿尼娅',
    kind: 'aniya',
    isDefault: true,
    createdAt: legacyPet.adoptedAt ?? now,
    archivedAt: null,
    enabled: false,

    hunger: legacyPet.hunger ?? 80,
    cleanliness: legacyPet.cleanliness ?? 80,
    mood: legacyPet.mood ?? 70,
    growth: legacyPet.growth ?? 0,
    coins: legacyPet.coins ?? 120,
    sleeping: legacyPet.sleeping ?? false,
    awayTask: legacyPet.awayTask ?? null,
    lastTickAt: legacyPet.lastTickAt ?? now,
    adoptedAt: legacyPet.adoptedAt ?? now,
    lastMilestoneDays: legacyPet.lastMilestoneDays ?? 0,
    proactiveDate: legacyPet.proactiveDate ?? '',
    proactiveCount: legacyPet.proactiveCount ?? 0,
    lastProactiveAt: legacyPet.lastProactiveAt ?? 0,
    coinCreditedExp: legacyPet.coinCreditedExp ?? 0,
    lastDailyBonusDate: legacyPet.lastDailyBonusDate ?? '',

    position: null,
    skinId: normalizeSkinId(legacySkin?.activeSkinId),

    agent: mergeAgent(legacyAgent),
    exp: mergeExp(legacyExp)
  }

  // Persist the new collection. Use the store's hydrate action so the live
  // state is updated as well (this is the only path that should ever call it).
  usePetsStore.getState().hydrate([migrated])

  // Same belt-and-suspenders fix as the first-time seed: wait for zustand
  // persist to write, then explicitly write the new collection blob so the
  // next `persist.rehydrate()` finds it even if the in-memory write was
  // still in flight.
  await new Promise((resolve) => setTimeout(resolve, 60))
  await writeJson('ola-pets-v1', {
    state: {
      pets: [migrated],
      enabledIds: [],
      activePetId: migrated.id,
      activeOnDesktopId: null
    },
    version: 1
  })

  // Skins: persist activeSkinId as a top-level field under the new key so the
  // skin store can later re-scan and pick up the directory-based entries.
  if (legacySkin?.activeSkinId) {
    await writeJson(NEW_SKINS_KEY, {
      state: { activeSkinId: normalizeSkinId(legacySkin.activeSkinId), legacyMigrated: true },
      version: 1
    })
  }

  // Mark done BEFORE deleting the legacy keys — if the marker write fails
  // we want a future retry to find the legacy data again rather than silently
  // drop the user state.
  await writeJson(MIGRATION_MARKER, '1')
  await removeKeys(LEGACY_KEYS)

  return { migrated: true, petId }
}

/**
 * True if the migration marker exists. Useful for the settings UI to show a
 * "Legacy data upgraded" hint, or to gate per-pet logic that depends on the
 * new structure being live.
 */
export async function hasPetMigrationRun(): Promise<boolean> {
  return (await ipcStorage.getItem(MIGRATION_MARKER)) === '1'
}

/** The active skin id that was carried over from the legacy single-skin state. */
export async function loadMigratedActiveSkinId(): Promise<string | null> {
  const raw = await readJson<LegacyPersisted<{ activeSkinId?: string | null }>>(NEW_SKINS_KEY)
  return normalizeSkinId(raw?.state?.activeSkinId)
}

/** Internal — exported only for tests. Re-runs the migration by clearing the marker. */
export async function _resetPetMigrationMarker(): Promise<void> {
  await ipcStorage.removeItem(MIGRATION_MARKER)
}

// Re-export the type-only skin alias so consumers don't import pets-store for it.
export type { PetSkin }
