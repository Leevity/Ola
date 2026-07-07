import { nanoid } from 'nanoid'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { usePetsStore } from '@renderer/stores/pets-store'
import { usePetExpStore } from '@renderer/stores/pet-exp-store'
import { usePetResourcePoolStore } from '@renderer/stores/pet-resource-pool-store'

/**
 * One XP per 1000 tokens — applies to every model, no premium multiplier.
 * Keeps the economy predictable: XP grows with usage, not with model price.
 */
export const TOKENS_PER_EXP = 1000

export function computePetExp(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  const exp = tokens / TOKENS_PER_EXP
  return Math.round(exp * 100) / 100
}

/**
 * Resolve the petId to record exp against. Uses the explicit arg if given,
 * otherwise falls back to the most recently active pet (legacy single-pet
 * callers don't know about petIds).
 */
function resolvePetId(explicit?: string | null): string | null {
  if (explicit) return explicit
  const pets = usePetsStore.getState().pets
  const activeId = usePetsStore.getState().activePetId
  if (activeId && pets.some((pet) => pet.id === activeId)) return activeId
  const enabled = usePetsStore.getState().enabledIds
  if (enabled.length > 0) return enabled[0] ?? null
  return pets[0]?.id ?? null
}

export interface AccruePetExpArgs {
  modelId: string | null
  modelName: string | null
  tokens: number
  /** Optional pet id; defaults to active pet for backward compatibility. */
  petId?: string | null
}

export async function accruePetExpFromUsage(args: AccruePetExpArgs): Promise<void> {
  const exp = computePetExp(args.tokens)
  if (exp <= 0) return
  const petId = resolvePetId(args.petId)
  if (!petId) return
  const entry = {
    id: nanoid(),
    at: Date.now(),
    model: args.modelName ?? args.modelId ?? 'unknown',
    tokens: Math.round(args.tokens),
    premium: false,
    exp
  }
  try {
    const isDefault =
      usePetsStore.getState().pets.find((pet) => pet.id === petId)?.isDefault === true
    // Optimistic local update so the pet reacts immediately even before the
    // main-process ledger writes. The main process is still the source of
    // truth and broadcasts `pet:sync-event { kind: 'exp' }` to reconcile.
    usePetsStore.getState().recordExp(petId, entry)
    if (isDefault) {
      usePetExpStore.setState((state) => ({
        totalExp: Math.round((state.totalExp + exp) * 100) / 100,
        totalTokens: state.totalTokens + (entry.tokens > 0 ? entry.tokens : 0),
        log: [entry, ...state.log].slice(0, 100)
      }))
    }
    await ipcClient.invoke('pet:exp-add', { petId, mirrorLegacyExp: isDefault, ...entry })
  } catch {
    // Experience accrual must never break usage recording.
  }
}

export function accruePetResourcePoolFromAmbientUsage(args: Omit<AccruePetExpArgs, 'petId'>): void {
  const exp = computePetExp(args.tokens)
  if (exp <= 0) return
  usePetResourcePoolStore.getState().addAmbientUsage({
    id: nanoid(),
    at: Date.now(),
    model: args.modelName ?? args.modelId ?? 'unknown',
    tokens: Math.round(args.tokens),
    exp,
    source: 'ambient-chat'
  })
}
