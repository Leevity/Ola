import {
  DEFAULT_SETTINGS_PAGE_ID,
  getSettingsPage,
  resolveSettingsNavigationTarget,
  SETTINGS_SECTION_IDS,
  type SettingsPageId,
  type SettingsSectionId
} from '@renderer/components/settings/settings-registry'

export interface SettingsRouteState {
  tab: SettingsPageId
  section: SettingsSectionId
  explicitTab: boolean
  canonicalHash: string
}

export const DEFAULT_SETTINGS_TAB = DEFAULT_SETTINGS_PAGE_ID

function normalizeHash(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const path = raw.trim()
  if (!path || path === '/') return '/'
  return path.startsWith('/') ? path : `/${path}`
}

function isSettingsSection(value: string): value is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(value)
}

export function buildSettingsRoute(tab?: SettingsPageId | null): string {
  const page =
    getSettingsPage(tab ?? DEFAULT_SETTINGS_PAGE_ID) ?? getSettingsPage(DEFAULT_SETTINGS_PAGE_ID)!
  return `#/settings/${encodeURIComponent(page.section)}/${encodeURIComponent(page.id)}`
}

export function buildUsageRoute(): string {
  return '#/usage'
}

export function buildPetStudioRoute(): string {
  return '#/pet-studio'
}

export function replaceSettingsRoute(tab?: SettingsPageId | null): void {
  const nextHash = buildSettingsRoute(tab)
  if (window.location.hash === nextHash) return
  window.history.replaceState(null, '', nextHash)
}

export function isSettingsTab(value: string): value is SettingsPageId {
  return getSettingsPage(value) !== null
}

export function parseSettingsRoute(hash: string): SettingsRouteState | null {
  const normalized = normalizeHash(hash)
  const [root, sectionSegment, pageSegment] = normalized.split('/').filter(Boolean)
  if (root !== 'settings') return null

  const rawSection = decodeURIComponent(sectionSegment ?? '')
  const rawPage = decodeURIComponent(pageSegment ?? '')
  const directTarget = resolveSettingsNavigationTarget(rawPage || rawSection || null)
  if (directTarget === 'usage' || directTarget === 'petStudio') return null

  const candidate = getSettingsPage(directTarget) ?? getSettingsPage(DEFAULT_SETTINGS_PAGE_ID)!
  const section =
    isSettingsSection(rawSection) && candidate.section === rawSection
      ? rawSection
      : candidate.section

  return {
    tab: candidate.id,
    section,
    explicitTab: Boolean(rawPage || rawSection),
    canonicalHash: buildSettingsRoute(candidate.id)
  }
}

export function parseSettingsDestination(
  hash: string
): SettingsPageId | 'usage' | 'petStudio' | null {
  const normalized = normalizeHash(hash)
  const [root, first, second] = normalized.split('/').filter(Boolean)
  if (root !== 'settings') return null
  const target = resolveSettingsNavigationTarget(decodeURIComponent(second ?? first ?? ''))
  return target
}
