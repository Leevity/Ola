import type { ComponentType } from 'react'
import { PermissionPanel } from './PermissionPanel'
import { ChannelPanel } from './PluginPanel'
import { CapabilityCenterPanel } from './CapabilityCenterPanel'
import { McpPanel } from './McpPanel'
import { WebSearchPanel } from './WebSearchPanel'
import { SkillsMarketPanel } from './SkillsMarketPanel'
import { CredentialsPanel } from '@renderer/components/credentials/CredentialsPanel'
import { ProjectIntelligenceDashboard } from './ProjectIntelligenceDashboard'
import { DesktopAutomationPanel } from './DesktopAutomationPanel'
import { WorkModesPanel } from './WorkModesPanel'
import { AdvancedSettingsPanel } from './AdvancedSettingsPanel'
import { ProfilePanel } from './ProfilePanel'
import { OlaAccountPanel } from './OlaAccountPanel'
import { MigrationPanel } from './MigrationPanel'
import type { SettingsPageId } from './settings-registry'

export type SettingsPanelComponent = ComponentType

/**
 * Component bindings are deliberately separate from the data-only route registry.
 * A page definition's component key is resolved here, while local legacy panels are
 * supplied by SettingsPage until they are split into their own modules.
 */
const EXTERNAL_PANEL_BINDINGS: Partial<Record<SettingsPageId, SettingsPanelComponent>> = {
  workModes: WorkModesPanel,
  permission: PermissionPanel,
  desktopAutomation: DesktopAutomationPanel,
  credentials: CredentialsPanel,
  plugin: CapabilityCenterPanel,
  extension: CapabilityCenterPanel,
  mcp: McpPanel,
  skillsmarket: SkillsMarketPanel,
  channel: ChannelPanel,
  websearch: WebSearchPanel,
  projectIntelligence: ProjectIntelligenceDashboard,
  profile: ProfilePanel,
  olaAccount: OlaAccountPanel,
  migration: MigrationPanel,
  advanced: AdvancedSettingsPanel
}

export function resolveSettingsPanel(
  pageId: SettingsPageId,
  localBindings: Partial<Record<SettingsPageId, SettingsPanelComponent>>
): SettingsPanelComponent {
  const panel = localBindings[pageId] ?? EXTERNAL_PANEL_BINDINGS[pageId]
  if (!panel) throw new Error(`Missing settings panel binding: ${pageId}`)
  return panel
}

export function renderSettingsPanel(
  pageId: SettingsPageId,
  localBindings: Partial<Record<SettingsPageId, SettingsPanelComponent>>
): React.JSX.Element {
  const Panel = resolveSettingsPanel(pageId, localBindings)
  return <Panel />
}

export function hasSettingsPanelBinding(pageId: SettingsPageId): boolean {
  return Boolean(EXTERNAL_PANEL_BINDINGS[pageId])
}
