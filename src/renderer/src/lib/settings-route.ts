import type { SettingsTab } from '@renderer/stores/ui-store'

export interface SettingsRouteState {
  tab: SettingsTab
  section: SettingsSection
  explicitTab: boolean
  canonicalHash: string
}

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'general'
export type SettingsSection =
  | 'general'
  | 'ai-models'
  | 'execution-security'
  | 'capabilities'
  | 'personalization'
  | 'data-usage'
  | 'about'

const SECTION_TABS: Record<SettingsSection, readonly SettingsTab[]> = {
  general: ['general', 'workModes'],
  'ai-models': ['provider', 'modelManagement', 'model'],
  'execution-security': ['permission', 'system', 'desktopAutomation', 'credentials'],
  capabilities: ['plugin', 'extension', 'mcp', 'websearch', 'skillsmarket', 'channel', 'wiki'],
  personalization: ['memory', 'pet'],
  'data-usage': ['analytics'],
  about: ['about']
}

function sectionForTab(tab: SettingsTab): SettingsSection {
  for (const [section, tabs] of Object.entries(SECTION_TABS) as Array<
    [SettingsSection, readonly SettingsTab[]]
  >) {
    if (tabs.includes(tab)) return section
  }
  return 'general'
}

function isSettingsSection(value: string): value is SettingsSection {
  return value in SECTION_TABS
}

const VALID_SETTINGS_TABS: ReadonlySet<SettingsTab> = new Set([
  'general',
  'workModes',
  'system',
  'permission',
  'hooks',
  'memory',
  'analytics',
  'provider',
  'modelManagement',
  'model',
  'plugin',
  'extension',
  'channel',
  'mcp',
  'websearch',
  'skillsmarket',
  'credentials',
  'wiki',
  'desktopAutomation',
  'pet',
  'aiCoding',
  'about'
])

function normalizeHash(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const path = raw.trim()
  if (!path || path === '/') return '/'
  return path.startsWith('/') ? path : `/${path}`
}

export function isSettingsTab(value: string): value is SettingsTab {
  return VALID_SETTINGS_TABS.has(value as SettingsTab)
}

export function buildSettingsRoute(tab?: SettingsTab | null): string {
  const resolvedTab = tab ?? DEFAULT_SETTINGS_TAB
  const section = sectionForTab(resolvedTab)
  const defaultTab = SECTION_TABS[section][0]
  return resolvedTab === defaultTab
    ? `#/settings/${encodeURIComponent(section)}`
    : `#/settings/${encodeURIComponent(section)}/${encodeURIComponent(resolvedTab)}`
}

export function replaceSettingsRoute(tab?: SettingsTab | null): void {
  const nextHash = buildSettingsRoute(tab)
  if (window.location.hash === nextHash) return
  window.history.replaceState(null, '', nextHash)
}

export function parseSettingsRoute(hash: string): SettingsRouteState | null {
  const normalized = normalizeHash(hash)
  const segments = normalized.split('/').filter(Boolean)

  if (segments[0] !== 'settings') return null

  const rawTab = decodeURIComponent(segments[1] ?? '')
  if (!rawTab) {
    return {
      tab: DEFAULT_SETTINGS_TAB,
      section: 'general',
      explicitTab: false,
      canonicalHash: buildSettingsRoute(DEFAULT_SETTINGS_TAB)
    }
  }

  if (isSettingsSection(rawTab)) {
    const rawNestedTab = decodeURIComponent(segments[2] ?? '')
    const nestedTab = isSettingsTab(rawNestedTab) ? rawNestedTab : SECTION_TABS[rawTab][0]
    const tab = SECTION_TABS[rawTab].includes(nestedTab) ? nestedTab : SECTION_TABS[rawTab][0]
    return {
      tab,
      section: rawTab,
      explicitTab: Boolean(rawNestedTab),
      canonicalHash: buildSettingsRoute(tab)
    }
  }

  if (isSettingsTab(rawTab)) {
    return {
      tab: rawTab,
      section: sectionForTab(rawTab),
      explicitTab: true,
      canonicalHash: buildSettingsRoute(rawTab)
    }
  }

  return {
    tab: DEFAULT_SETTINGS_TAB,
    section: 'general',
    explicitTab: false,
    canonicalHash: buildSettingsRoute(DEFAULT_SETTINGS_TAB)
  }
}
