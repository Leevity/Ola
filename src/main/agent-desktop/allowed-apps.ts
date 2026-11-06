import { getConfigValue } from '../ipc/secure-key-store'

const APP_PLUGIN_CONFIG_KEY = 'ola-app-plugins'
const GLOBAL_PROJECT_ID = '__global__'

/** The plugin that owns the accessibility tools. Main reads its bound without depending on the
 * renderer's plugin registry, which is the same way the browser plugin's domain lists arrive. */
export const DESKTOP_ACCESSIBILITY_PLUGIN_ID = 'desktop-accessibility'

const MAX_APPS = 200
const MAX_APP_LENGTH = 120

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function pluginList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Record<string, unknown> => item !== null)
    : []
}

function configState(value: unknown): Record<string, unknown> | null {
  const outer = record(value)
  return record(outer?.state) ?? outer
}

/**
 * Application names are matched case-insensitively by the tool, but their spelling is what the
 * model sees and what the OS reports, so the list keeps the entered case while deduplicating
 * without regard to it.
 */
export function normalizeAllowedApps(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const apps: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim().replace(/\s+/g, ' ').slice(0, MAX_APP_LENGTH)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    apps.push(name)
    if (apps.length >= MAX_APPS) break
  }
  return apps
}

/**
 * The application bound for this run, read from the persisted app-plugin configuration.
 *
 * An empty list means no bound is configured, which the tool treats as unbounded rather than as
 * "nothing is allowed". That is a deliberate fail-open, not an oversight: no settings surface writes
 * `desktopAllowedApps` yet (`desktop-accessibility` exists only as this Main-side id, and no
 * renderer plugin registers it), so treating the empty list as a denial would reject every call
 * before any user can change it. Desktop-AX stays locked today because no product flow names these
 * tools at all — see the agent-desktop rows in the TS-runtime acceptance ledger.
 */
export async function resolveDesktopAxAllowedApps(projectId?: string | null): Promise<string[]> {
  const persisted = configState(await getConfigValue(APP_PLUGIN_CONFIG_KEY))
  const byProject = record(persisted?.pluginsByProject)
  const global = pluginList(byProject?.[GLOBAL_PROJECT_ID]).find(
    (plugin) => plugin.id === DESKTOP_ACCESSIBILITY_PLUGIN_ID
  )
  const override = projectId
    ? pluginList(byProject?.[projectId]).find(
        (plugin) => plugin.id === DESKTOP_ACCESSIBILITY_PLUGIN_ID
      )
    : undefined
  return normalizeAllowedApps({ ...global, ...override }?.desktopAllowedApps)
}
