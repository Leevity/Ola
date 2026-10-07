import { createIpcStateStorage } from './ipc-state-storage'

type SettingsWriteStatus = 'saving' | 'saved' | 'failed'
const settingsWriteListeners = new Set<(status: SettingsWriteStatus) => void>()
let settingsWriteStatus: SettingsWriteStatus = 'saved'

export function getSettingsWriteStatus(): SettingsWriteStatus {
  return settingsWriteStatus
}

export function subscribeSettingsWriteStatus(
  listener: (status: SettingsWriteStatus) => void
): () => void {
  settingsWriteListeners.add(listener)
  return () => settingsWriteListeners.delete(listener)
}

export function waitForSettingsWriteIdle(): Promise<void> {
  if (settingsWriteStatus !== 'saving') return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = subscribeSettingsWriteStatus((status) => {
      if (status === 'saving') return
      unsubscribe()
      resolve()
    })
    if (settingsWriteStatus !== 'saving') {
      unsubscribe()
      resolve()
    }
  })
}

/**
 * Custom Zustand StateStorage that delegates to main process settings.json
 * via IPC, replacing localStorage.
 */
export const ipcStorage = createIpcStateStorage({
  getChannel: 'settings:get',
  setChannel: 'settings:set',
  mergeStateName: 'ola-settings',
  onWriteStatus: ({ name, status }) => {
    if (name !== 'ola-settings') return
    settingsWriteStatus = status
    for (const listener of settingsWriteListeners) listener(status)
  }
})
