export const BUILTIN_BROWSER_PARTITION = 'persist:ola-browser'
export const LOCAL_PERSONAL_WORKSPACE_ID = 'local-personal'
export const BROWSER_SETTINGS_STORAGE_KEY = 'ola-settings'
export const BROWSER_USER_DATA_REUSE_SETTING_KEY = 'browserUserDataReuseEnabled'
export const BROWSER_USER_DATA_SOURCE_SETTING_KEY = 'browserUserDataSource'

export const BROWSER_USER_DATA_SOURCES = ['auto', 'chrome', 'edge', 'brave', 'chromium'] as const
export type BrowserUserDataSource = (typeof BROWSER_USER_DATA_SOURCES)[number]
export type ConcreteBrowserUserDataSource = Exclude<BrowserUserDataSource, 'auto'>
export const DEFAULT_BROWSER_USER_DATA_SOURCE: BrowserUserDataSource = 'auto'

export function isBrowserUserDataReuseEnabled(value: unknown): boolean {
  return value !== false
}

export function normalizeBrowserUserDataSource(value: unknown): BrowserUserDataSource {
  return BROWSER_USER_DATA_SOURCES.includes(value as BrowserUserDataSource)
    ? (value as BrowserUserDataSource)
    : DEFAULT_BROWSER_USER_DATA_SOURCE
}

export function stripElectronFromUserAgent(userAgent: string): string {
  return userAgent.replace(/\sElectron\/[^\s]+/g, '').trim()
}

/**
 * Keep the historical local partition so existing personal cookies survive
 * the migration. Every other workspace receives its own persistent Electron
 * partition; a renderer cannot make two workspace ids resolve to the same
 * partition by using separators or Unicode escapes.
 */
export function browserPartitionForWorkspace(workspaceId: string): string {
  const normalized = workspaceId.trim()
  if (!normalized || normalized === LOCAL_PERSONAL_WORKSPACE_ID) return BUILTIN_BROWSER_PARTITION
  return `${BUILTIN_BROWSER_PARTITION}-${encodeURIComponent(normalized)}`
}

/** External browser data belongs only to the local personal workspace. */
export function usesDefaultBrowserSession(workspaceId: string, reuseEnabled: boolean): boolean {
  return reuseEnabled && workspaceId === LOCAL_PERSONAL_WORKSPACE_ID
}

export function isBuiltInBrowserPartition(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value === BUILTIN_BROWSER_PARTITION || value.startsWith(`${BUILTIN_BROWSER_PARTITION}-`))
  )
}
