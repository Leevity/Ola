import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { usePetAgentStore, type PetAgentConfig } from '@renderer/stores/pet-agent-store'
import { usePetExpStore } from '@renderer/stores/pet-exp-store'
import { usePetStore, type PetActionResult } from '@renderer/stores/pet-store'
import { usePetsStore, type Pet, type PetActionName } from '@renderer/stores/pets-store'

const LEGACY_SYNC_KIND = 'legacy-pet'
let broadcastTimer: number | null = null

interface LegacyPetSyncEvent {
  kind?: string
  payload?: Partial<Pet>
}

interface LegacyAgentSyncEvent {
  kind?: string
  payload?: Partial<PetAgentConfig> & { petId?: string }
}

function normalizeDefaultName(name: string): string {
  const trimmed = name.trim()
  return trimmed === 'Kapi' || trimmed === '阿尼娅' || trimmed === '' ? 'Aniya' : trimmed
}

export function getDefaultPetId(): string | null {
  return usePetsStore.getState().pets.find((pet) => pet.isDefault)?.id ?? null
}

function buildDefaultPetPatch(): Partial<Pet> {
  const pet = usePetStore.getState()
  const exp = usePetExpStore.getState()
  const name = normalizeDefaultName(pet.name)
  if (name !== pet.name) {
    usePetStore.setState({ name })
  }
  // NOTE: the legacy → multi-pet sync intentionally only carries
  // profile-shaped fields (name, skinId, exp ledger, scheduling metadata).
  // We deliberately do NOT forward hunger/cleanliness/mood/growth/sleeping
  // /awayTask from the legacy store, because:
  //   1. multi-pet owns those state fields once the desktop pet window
  //      is up — every `actOnPet` call writes them through
  //      `usePetsStore.setState`, and feeding the legacy value back over
  //      those writes clobbers the user-visible stats.
  //   2. The legacy `tick()` decay runs every PET_TICK_MS and unconditionally
  //      calls `set`, which fires the `usePetStore.subscribe(sync)` we
  //      install below. Without this carve-out, the legacy 30s tick would
  //      overwrite the multi-pet stat bars with the legacy decay snapshot
  //      on every beat. The user reported the stat numbers snapping back
  //      to "0" after every feed/bathe action — that was the symptom.
  return {
    name,
    adoptedAt: pet.adoptedAt,
    lastMilestoneDays: pet.lastMilestoneDays,
    proactiveDate: pet.proactiveDate,
    proactiveCount: pet.proactiveCount,
    lastProactiveAt: pet.lastProactiveAt,
    coinCreditedExp: pet.coinCreditedExp,
    lastDailyBonusDate: pet.lastDailyBonusDate,
    skinId: 'aniya',
    exp: {
      totalExp: exp.totalExp,
      totalTokens: exp.totalTokens,
      log: exp.log
    }
  }
}

export function isDefaultPet(petId: string): boolean {
  return getDefaultPetId() === petId
}

export function syncLegacyPetToDefaultPet(): void {
  applyDefaultPetPatch(buildDefaultPetPatch())
}

function applyDefaultPetPatch(patch: Partial<Pet>): void {
  const defaultId = getDefaultPetId()
  if (!defaultId) return
  usePetsStore.setState((state) => ({
    pets: state.pets.map((pet) => (pet.id === defaultId ? { ...pet, ...patch } : pet))
  }))
}

export function broadcastLegacyPetChanged(): void {
  if (broadcastTimer !== null) window.clearTimeout(broadcastTimer)
  broadcastTimer = window.setTimeout(() => {
    broadcastTimer = null
    void ipcClient
      .invoke('pet:sync', { kind: LEGACY_SYNC_KIND, payload: buildDefaultPetPatch() })
      .catch(() => undefined)
  }, 80)
}

export function renameDefaultPet(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  usePetStore.setState({ name: trimmed })
  syncLegacyPetToDefaultPet()
  void ipcClient
    .invoke('pet:sync', { kind: 'profile', payload: { name: trimmed } })
    .catch(() => undefined)
  broadcastLegacyPetChanged()
}

function applyDefaultAgentConfig(config: Partial<PetAgentConfig>): void {
  usePetAgentStore.getState().setConfig(config)
  const defaultId = getDefaultPetId()
  if (!defaultId) return
  usePetsStore.setState((state) => ({
    pets: state.pets.map((pet) =>
      pet.id === defaultId ? { ...pet, agent: { ...pet.agent, ...config } } : pet
    )
  }))
}

export function syncDefaultPetAgentToLegacy(): void {
  const defaultPet = usePetsStore.getState().pets.find((pet) => pet.isDefault)
  if (!defaultPet) return
  applyDefaultAgentConfig(defaultPet.agent)
}

export function updateDefaultPetAgent(config: Partial<PetAgentConfig>): void {
  applyDefaultAgentConfig(config)
  void ipcClient
    .invoke('pet:sync', { kind: 'agent-config', payload: config })
    .catch(() => undefined)
}

export function actOnDefaultPet(action: PetActionName): PetActionResult | null {
  const store = usePetStore.getState()
  let result: PetActionResult | null = null

  switch (action) {
    case 'feed':
      result = store.feed()
      break
    case 'bathe':
      result = store.bathe()
      break
    case 'soak':
      result = store.soak()
      break
    case 'play':
      result = store.play()
      break
    case 'toggleSleep':
      store.toggleSleep()
      result = { ok: true }
      break
    case 'startWork':
      result = store.startWork()
      break
    case 'startStudy':
      result = store.startStudy()
      break
    case 'resolveAwayTask':
      result = store.resolveAwayTask() ? { ok: true } : { ok: false, reason: 'busy' }
      break
    case 'petted':
      store.petted()
      result = { ok: true }
      break
    case 'creditExpCoins':
      result = store.creditExpCoins() > 0 ? { ok: true } : { ok: false, reason: 'full' }
      break
    case 'claimDailyBonus':
      result = store.claimDailyBonus() ? { ok: true } : { ok: false, reason: 'full' }
      break
    case 'markMilestone':
    case 'recordProactive':
    case 'addCoins':
      result = null
      break
  }

  syncLegacyPetToDefaultPet()
  broadcastLegacyPetChanged()
  return result
}

export function installDefaultPetSync(options: { broadcast?: boolean } = {}): () => void {
  void Promise.resolve(usePetsStore.persist.rehydrate()).then(() => {
    syncLegacyPetToDefaultPet()
    syncDefaultPetAgentToLegacy()
  })
  syncLegacyPetToDefaultPet()
  syncDefaultPetAgentToLegacy()

  const sync = (): void => {
    syncLegacyPetToDefaultPet()
    if (options.broadcast) broadcastLegacyPetChanged()
  }

  const unsubscribePet = usePetStore.subscribe(sync)
  const unsubscribeExp = usePetExpStore.subscribe(sync)
  const unsubscribeIpc = ipcClient.on('pet:sync-event', (payload) => {
    const event = payload as LegacyPetSyncEvent | null
    if (event?.kind === LEGACY_SYNC_KIND) {
      if (event.payload) applyDefaultPetPatch(event.payload)
      void Promise.all([usePetStore.persist.rehydrate(), usePetExpStore.persist.rehydrate()]).then(
        () => {
          if (event.payload) applyDefaultPetPatch(event.payload)
          else syncLegacyPetToDefaultPet()
        }
      )
      return
    }

    const agentEvent = payload as LegacyAgentSyncEvent | null
    if (agentEvent?.kind === 'agent-config') {
      if (agentEvent.payload) applyDefaultAgentConfig(agentEvent.payload)
      void Promise.resolve(usePetAgentStore.persist.rehydrate()).then(() => {
        if (agentEvent.payload) applyDefaultAgentConfig(agentEvent.payload)
      })
    }
  })

  return () => {
    unsubscribePet()
    unsubscribeExp()
    unsubscribeIpc()
  }
}
