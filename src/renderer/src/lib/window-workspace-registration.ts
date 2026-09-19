import { ipcClient } from './ipc/ipc-client'

let registeredWorkspaceId: string | null = null
let pending: { workspaceId: string; promise: Promise<void> } | null = null

export function invalidateWindowWorkspaceRegistration(): void {
  registeredWorkspaceId = null
  pending = null
}

export async function ensureWindowWorkspaceRegistered(workspaceId: string): Promise<void> {
  if (registeredWorkspaceId === workspaceId) return
  if (pending?.workspaceId === workspaceId) return pending.promise
  const promise = ipcClient
    .invoke('window:workspace:set', { workspaceId })
    .then((result) => {
      if (
        !result ||
        typeof result !== 'object' ||
        (result as { workspaceId?: unknown }).workspaceId !== workspaceId
      )
        throw new Error('WINDOW_WORKSPACE_UNAVAILABLE')
      if (pending?.promise === promise) registeredWorkspaceId = workspaceId
    })
    .finally(() => {
      if (pending?.promise === promise) pending = null
    })
  pending = { workspaceId, promise }
  return promise
}
