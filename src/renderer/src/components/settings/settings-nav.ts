import type { SettingsTab } from '@renderer/stores/ui-store'

export const settingsFullPanelTabs = new Set<SettingsTab>([
  'provider',
  'workModes',
  'model',
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
  if (tab === 'wiki' || tab === 'extension') return 'plugin'
  return tab
}

export function isSettingsFullPanelTab(tab: SettingsTab): boolean {
  return settingsFullPanelTabs.has(tab)
}
