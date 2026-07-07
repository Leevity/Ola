import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { ipcStorage } from '@renderer/lib/ipc/ipc-storage'

interface PetWalletStore {
  coins: number
  addCoins: (amount: number) => void
  spendCoins: (amount: number) => boolean
}

function normalizeAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return Math.round(amount * 100) / 100
}

export const usePetWalletStore = create<PetWalletStore>()(
  persist(
    (set, get) => ({
      coins: 120,
      addCoins: (amount) => {
        const value = normalizeAmount(amount)
        if (value <= 0) return
        set((state) => ({ coins: Math.round((state.coins + value) * 100) / 100 }))
      },
      spendCoins: (amount) => {
        const value = normalizeAmount(amount)
        if (value <= 0) return true
        if (get().coins < value) return false
        set((state) => ({ coins: Math.round((state.coins - value) * 100) / 100 }))
        return true
      }
    }),
    {
      name: 'ola-pet-wallet-v1',
      storage: createJSONStorage(() => ipcStorage)
    }
  )
)
