type AccountClearedListener = () => Promise<void> | void
type WorkspaceDirectoryListener = (availableIds: ReadonlySet<string>) => Promise<void> | void

const accountClearedListeners = new Set<AccountClearedListener>()
const workspaceDirectoryListeners = new Set<WorkspaceDirectoryListener>()

export function onRemoteAccountCleared(listener: AccountClearedListener): () => void {
  accountClearedListeners.add(listener)
  return () => accountClearedListeners.delete(listener)
}

export async function notifyRemoteAccountCleared(): Promise<void> {
  const results = await Promise.allSettled(
    [...accountClearedListeners].map((listener) => Promise.resolve().then(listener))
  )
  for (const result of results) {
    if (result.status === 'rejected')
      console.warn('[Remote Account] Cleanup failed:', result.reason)
  }
}

export function onWorkspaceDirectoryChanged(listener: WorkspaceDirectoryListener): () => void {
  workspaceDirectoryListeners.add(listener)
  return () => workspaceDirectoryListeners.delete(listener)
}

export async function notifyWorkspaceDirectoryChanged(
  availableIds: ReadonlySet<string>
): Promise<void> {
  const results = await Promise.allSettled(
    [...workspaceDirectoryListeners].map((listener) =>
      Promise.resolve().then(() => listener(availableIds))
    )
  )
  for (const result of results) {
    if (result.status === 'rejected')
      console.warn('[Remote Account] Workspace cleanup failed:', result.reason)
  }
}
