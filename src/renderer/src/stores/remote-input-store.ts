import { create } from 'zustand'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

export type RemoteInputProbeStatus = 'idle' | 'checking' | 'available' | 'unavailable'

type DesktopInputStatusResult = {
  available: boolean
  error?: string
}

type RemoteInputStore = {
  status: RemoteInputProbeStatus
  error: string | null
  checkedAt: number | null
  checkAvailability: () => Promise<void>
}

export const useRemoteInputStore = create<RemoteInputStore>((set) => ({
  status: 'idle',
  error: null,
  checkedAt: null,
  checkAvailability: async () => {
    set({ status: 'checking', error: null })
    try {
      const result = (await ipcClient.invoke(IPC.DESKTOP_INPUT_STATUS)) as DesktopInputStatusResult
      set({
        status: result.available ? 'available' : 'unavailable',
        error: result.error ?? null,
        checkedAt: Date.now()
      })
    } catch (error) {
      set({
        status: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now()
      })
      throw error
    }
  }
}))
