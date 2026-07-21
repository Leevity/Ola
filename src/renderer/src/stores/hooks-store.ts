import { create } from 'zustand'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import type { HookRunRecord, LoadedHook } from '../../../shared/hooks/types'

interface HooksStore {
  hooks: LoadedHook[]
  history: HookRunRecord[]
  loading: boolean
  error: string | null
  refresh: (projectPath?: string) => Promise<void>
  trust: (trustKey: string, projectPath?: string) => Promise<void>
  revoke: (trustKey: string, projectPath?: string) => Promise<void>
}

export const useHooksStore = create<HooksStore>((set, get) => ({
  hooks: [],
  history: [],
  loading: false,
  error: null,
  refresh: async (projectPath) => {
    set({ loading: true, error: null })
    try {
      const [hooks, history] = await Promise.all([
        ipcClient.invoke('hooks:list', { projectPath }) as Promise<LoadedHook[]>,
        ipcClient.invoke('hooks:history', {}) as Promise<HookRunRecord[]>
      ])
      set({ hooks, history, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },
  trust: async (trustKey, projectPath) => {
    await ipcClient.invoke('hooks:trust', { trustKey, projectPath })
    await get().refresh(projectPath)
  },
  revoke: async (trustKey, projectPath) => {
    await ipcClient.invoke('hooks:revoke', { trustKey })
    await get().refresh(projectPath)
  }
}))
