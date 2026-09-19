import {
  getSettingsPage,
  type SettingsNavigationTarget,
  type SettingsPageId
} from './settings-registry'

export type { SettingsNavigationTarget, SettingsPageId }

export function isSettingsFullPanelTab(tab: SettingsPageId): boolean {
  return getSettingsPage(tab)?.layout === 'full'
}
