import { publicWorkspaceDirectory } from '../../shared/workspace-directory'

export const OFFLINE_WORKSPACE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface OfflineWorkspaceSnapshot {
  accountId: string
  apiBaseUrl: string
  fetchedAt: number
  directory: ReturnType<typeof publicWorkspaceDirectory>
}

export function cachedWorkspaceExpiresAt(
  accountId: unknown,
  apiBaseUrl: string,
  cached: OfflineWorkspaceSnapshot | undefined,
  now = Date.now()
): number | null {
  if (
    typeof accountId !== 'string' ||
    !cached ||
    cached.accountId !== accountId ||
    cached.apiBaseUrl !== apiBaseUrl ||
    !Number.isFinite(cached.fetchedAt) ||
    cached.fetchedAt > now
  )
    return null
  return cached.fetchedAt + OFFLINE_WORKSPACE_CACHE_MAX_AGE_MS + 1
}

export function cachedWorkspaceDirectory(
  accountId: unknown,
  apiBaseUrl: string,
  cached: OfflineWorkspaceSnapshot | undefined,
  now = Date.now()
): ReturnType<typeof publicWorkspaceDirectory> | null {
  const expiresAt = cachedWorkspaceExpiresAt(accountId, apiBaseUrl, cached, now)
  if (!cached || expiresAt === null || now >= expiresAt) return null
  return publicWorkspaceDirectory(cached.directory)
}

export function isOfflineTransportError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
  )
}
