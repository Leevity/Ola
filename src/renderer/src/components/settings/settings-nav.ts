import type { SettingsTab } from '@renderer/stores/ui-store'

export const settingsFullPanelTabs = new Set<SettingsTab>([
  'provider',
  'modelManagement',
  'aiCoding',
  'plugin',
  'extension',
  'mcp',
  'credentials',
  'wiki',
  'desktopAutomation'
])

export function normalizeSettingsTab(tab: SettingsTab): SettingsTab {
  return tab === 'channel' ? 'general' : tab
}

export function isSettingsFullPanelTab(tab: SettingsTab): boolean {
  return settingsFullPanelTabs.has(tab)
}
