export const SETTINGS_SECTION_IDS = [
  'common',
  'models',
  'execution',
  'integrations',
  'personalization',
  'advanced'
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]
export type SettingsLayout = 'standard' | 'full'
export type SettingsIcon =
  | 'settings'
  | 'briefcase'
  | 'info'
  | 'server'
  | 'cloud'
  | 'sliders'
  | 'layers'
  | 'shield'
  | 'terminal'
  | 'mouse'
  | 'key'
  | 'puzzle'
  | 'wand'
  | 'cable'
  | 'messages'
  | 'globe'
  | 'network'
  | 'user'
  | 'book'
  | 'flask'

export type SettingsPageId =
  | 'general'
  | 'workModes'
  | 'about'
  | 'provider'
  | 'modelManagement'
  | 'model'
  | 'olaAccount'
  | 'permission'
  | 'system'
  | 'desktopAutomation'
  | 'credentials'
  | 'plugin'
  | 'extension'
  | 'mcp'
  | 'skillsmarket'
  | 'channel'
  | 'websearch'
  | 'projectIntelligence'
  | 'profile'
  | 'memory'
  | 'advanced'

export type LegacySettingsPageId = 'hooks' | 'aiCoding' | 'analytics' | 'pet' | 'wiki'
export type SettingsNavigationTarget = SettingsPageId | LegacySettingsPageId

export interface SettingsSectionDefinition {
  id: SettingsSectionId
  labelKey: string
}

export interface SettingsPageDefinition {
  id: SettingsPageId
  section: SettingsSectionId
  titleKey: string
  descriptionKey: string
  icon: SettingsIcon
  layout: SettingsLayout
  /** Existing component key. Kept data-only so routing has no component imports. */
  component: SettingsPageId
  legacyIds?: readonly string[]
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  { id: 'common', labelKey: 'architecture.groups.common' },
  { id: 'models', labelKey: 'architecture.groups.models' },
  { id: 'execution', labelKey: 'architecture.groups.execution' },
  { id: 'integrations', labelKey: 'architecture.groups.integrations' },
  { id: 'personalization', labelKey: 'architecture.groups.personalization' },
  { id: 'advanced', labelKey: 'architecture.groups.advanced' }
]

export const SETTINGS_REGISTRY: readonly SettingsPageDefinition[] = [
  {
    id: 'general',
    section: 'common',
    titleKey: 'general.title',
    descriptionKey: 'general.subtitle',
    icon: 'settings',
    layout: 'standard',
    component: 'general'
  },
  {
    id: 'workModes',
    section: 'common',
    titleKey: 'workModes.title',
    descriptionKey: 'workModes.subtitle',
    icon: 'briefcase',
    layout: 'full',
    component: 'workModes'
  },
  {
    id: 'about',
    section: 'common',
    titleKey: 'about.title',
    descriptionKey: 'about.subtitle',
    icon: 'info',
    layout: 'standard',
    component: 'about'
  },
  {
    id: 'provider',
    section: 'models',
    titleKey: 'provider.title',
    descriptionKey: 'provider.subtitle',
    icon: 'server',
    layout: 'full',
    component: 'provider'
  },
  {
    id: 'modelManagement',
    section: 'models',
    titleKey: 'provider.modelManagement',
    descriptionKey: 'architecture.pages.modelManagement.description',
    icon: 'layers',
    layout: 'full',
    component: 'modelManagement'
  },
  {
    id: 'model',
    section: 'models',
    titleKey: 'model.title',
    descriptionKey: 'architecture.pages.model.description',
    icon: 'sliders',
    layout: 'full',
    component: 'model'
  },
  {
    id: 'olaAccount',
    section: 'models',
    titleKey: 'architecture.pages.olaAccount.title',
    descriptionKey: 'architecture.pages.olaAccount.description',
    icon: 'cloud',
    layout: 'standard',
    component: 'olaAccount'
  },
  {
    id: 'permission',
    section: 'execution',
    titleKey: 'permission.title',
    descriptionKey: 'permission.subtitle',
    icon: 'shield',
    layout: 'standard',
    component: 'permission'
  },
  {
    id: 'system',
    section: 'execution',
    titleKey: 'system.title',
    descriptionKey: 'system.subtitle',
    icon: 'terminal',
    layout: 'standard',
    component: 'system'
  },
  {
    id: 'desktopAutomation',
    section: 'execution',
    titleKey: 'desktopAutomation.title',
    descriptionKey: 'desktopAutomation.subtitle',
    icon: 'mouse',
    layout: 'full',
    component: 'desktopAutomation'
  },
  {
    id: 'credentials',
    section: 'execution',
    titleKey: 'credentials.title',
    descriptionKey: 'credentials.subtitle',
    icon: 'key',
    layout: 'full',
    component: 'credentials'
  },
  {
    id: 'plugin',
    section: 'integrations',
    titleKey: 'plugin.title',
    descriptionKey: 'plugin.subtitle',
    icon: 'puzzle',
    layout: 'full',
    component: 'plugin'
  },
  {
    id: 'extension',
    section: 'integrations',
    titleKey: 'extension.title',
    descriptionKey: 'extension.subtitle',
    icon: 'puzzle',
    layout: 'full',
    component: 'extension'
  },
  {
    id: 'mcp',
    section: 'integrations',
    titleKey: 'mcp.title',
    descriptionKey: 'mcp.subtitle',
    icon: 'cable',
    layout: 'full',
    component: 'mcp'
  },
  {
    id: 'skillsmarket',
    section: 'integrations',
    titleKey: 'skillsmarket.title',
    descriptionKey: 'skillsmarket.subtitle',
    icon: 'wand',
    layout: 'full',
    component: 'skillsmarket'
  },
  {
    id: 'channel',
    section: 'integrations',
    titleKey: 'channel.title',
    descriptionKey: 'channel.subtitle',
    icon: 'messages',
    layout: 'standard',
    component: 'channel'
  },
  {
    id: 'websearch',
    section: 'integrations',
    titleKey: 'websearch.title',
    descriptionKey: 'websearch.subtitle',
    icon: 'globe',
    layout: 'standard',
    component: 'websearch'
  },
  {
    id: 'projectIntelligence',
    section: 'integrations',
    titleKey: 'architecture.pages.projectIntelligence.title',
    descriptionKey: 'architecture.pages.projectIntelligence.description',
    icon: 'network',
    layout: 'full',
    component: 'projectIntelligence',
    legacyIds: ['wiki']
  },
  {
    id: 'profile',
    section: 'personalization',
    titleKey: 'profile.title',
    descriptionKey: 'profile.subtitle',
    icon: 'user',
    layout: 'standard',
    component: 'profile'
  },
  {
    id: 'memory',
    section: 'personalization',
    titleKey: 'memory.title',
    descriptionKey: 'memory.subtitle',
    icon: 'book',
    layout: 'standard',
    component: 'memory'
  },
  {
    id: 'advanced',
    section: 'advanced',
    titleKey: 'architecture.pages.advanced.title',
    descriptionKey: 'architecture.pages.advanced.description',
    icon: 'flask',
    layout: 'standard',
    component: 'advanced',
    legacyIds: ['hooks', 'aiCoding']
  }
]

const pageById = new Map(SETTINGS_REGISTRY.map((page) => [page.id, page]))
const legacyPageTargets: Readonly<
  Record<LegacySettingsPageId, SettingsPageId | 'usage' | 'petStudio'>
> = {
  hooks: 'advanced',
  aiCoding: 'advanced',
  analytics: 'usage',
  pet: 'petStudio',
  wiki: 'projectIntelligence'
}

const legacySectionTargets: Readonly<Record<string, SettingsPageId | 'usage' | 'petStudio'>> = {
  'ai-models': 'provider',
  'execution-security': 'permission',
  capabilities: 'plugin',
  personalization: 'memory',
  'data-usage': 'usage'
}

export const DEFAULT_SETTINGS_PAGE_ID: SettingsPageId = 'general'

export function getSettingsPage(id: string | null | undefined): SettingsPageDefinition | null {
  return id ? (pageById.get(id as SettingsPageId) ?? null) : null
}

export function getPagesForSection(section: SettingsSectionId): readonly SettingsPageDefinition[] {
  return SETTINGS_REGISTRY.filter((page) => page.section === section)
}

export function resolveSettingsNavigationTarget(
  target?: SettingsNavigationTarget | string | null
): SettingsPageId | 'usage' | 'petStudio' {
  if (!target) return DEFAULT_SETTINGS_PAGE_ID
  return (
    getSettingsPage(target)?.id ??
    legacyPageTargets[target as LegacySettingsPageId] ??
    legacySectionTargets[target] ??
    DEFAULT_SETTINGS_PAGE_ID
  )
}
