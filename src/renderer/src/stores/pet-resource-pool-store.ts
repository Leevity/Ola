import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { ipcStorage } from '@renderer/lib/ipc/ipc-storage'
import { usePetsStore, type PetExpLogEntry } from './pets-store'
import { usePetWalletStore } from './pet-wallet-store'

export interface PetResourcePoolLogEntry {
  id: string
  at: number
  model: string
  tokens: number
  exp: number
  source: 'ambient-chat'
}

interface PetResourcePoolStore {
  availableExp: number
  totalExp: number
  totalTokens: number
  log: PetResourcePoolLogEntry[]
  addAmbientUsage: (entry: PetResourcePoolLogEntry) => void
  grantExpToPet: (petId: string, amount: number) => boolean
  convertExpToCoins: (amount: number) => boolean
}

function clampAmount(amount: number, max: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return Math.min(max, Math.round(amount * 100) / 100)
}

export const usePetResourcePoolStore = create<PetResourcePoolStore>()(
  persist(
    (set, get) => ({
      availableExp: 0,
      totalExp: 0,
      totalTokens: 0,
      log: [],
      addAmbientUsage: (entry) => {
        const gainedExp = Math.max(0, entry.exp)
        const tokens = entry.tokens > 0 ? entry.tokens : 0
        set((state) => ({
          availableExp: Math.round((state.availableExp + gainedExp) * 100) / 100,
          totalExp: Math.round((state.totalExp + gainedExp) * 100) / 100,
          totalTokens: state.totalTokens + tokens,
          log: [entry, ...state.log].slice(0, 100)
        }))
      },
      grantExpToPet: (petId, amount) => {
        const exp = clampAmount(amount, get().availableExp)
        if (exp <= 0) return false
        const entry: PetExpLogEntry = {
          id: crypto.randomUUID(),
          at: Date.now(),
          model: 'Ola resource pool',
          tokens: 0,
          exp
        }
        usePetsStore.getState().recordExp(petId, entry)
        set((state) => ({
          availableExp: Math.round((state.availableExp - exp) * 100) / 100
        }))
        return true
      },
      convertExpToCoins: (amount) => {
        const coins = clampAmount(amount, get().availableExp)
        if (coins <= 0) return false
        set((state) => ({
          availableExp: Math.round((state.availableExp - coins) * 100) / 100
        }))
        usePetWalletStore.getState().addCoins(coins)
        return true
      }
    }),
    {
      name: 'ola-pet-resource-pool-v1',
      storage: createJSONStorage(() => ipcStorage)
    }
  )
)
