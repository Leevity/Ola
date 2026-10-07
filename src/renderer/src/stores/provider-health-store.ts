import { create } from 'zustand'
import type {
  ProviderCandidate,
  ProviderHealth,
  ProviderResolution
} from '../../../shared/provider-health'
import { ipcClient } from '../lib/ipc/ipc-client'

interface ProviderHealthState {
  providers: ProviderHealth[]
  loading: boolean
  loadedAt: number | null
  loadError: string | null
  load: () => Promise<void>
  reset: (providerKey?: string) => Promise<void>
  resolveFallback: (args: {
    preferredProviderId?: string | null
    preferredModelId?: string | null
    candidates: ProviderCandidate[]
    requireVision?: boolean
    requireComputerUse?: boolean
  }) => Promise<ProviderResolution>
}

export const useProviderHealthStore = create<ProviderHealthState>((set) => ({
  providers: [],
  loading: false,
  loadedAt: null,
  loadError: null,
  load: async () => {
    set({ loading: true, loadError: null })
    try {
      const snapshot = (await ipcClient.invoke('provider:health')) as {
        providers?: ProviderHealth[]
      }
      set({ providers: snapshot.providers ?? [], loadedAt: Date.now(), loadError: null })
    } catch (error) {
      set({
        providers: [],
        loadedAt: null,
        loadError: error instanceof Error ? error.message : String(error)
      })
    } finally {
      set({ loading: false })
    }
  },
  reset: async (providerKey) => {
    await ipcClient.invoke('provider:health:reset', providerKey ? { providerKey } : undefined)
    await useProviderHealthStore.getState().load()
  },
  resolveFallback: async (args) => {
    return (await ipcClient.invoke('provider:fallback:resolve', args)) as ProviderResolution
  }
}))
