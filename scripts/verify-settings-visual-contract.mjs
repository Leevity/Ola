import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
// This small script executes at module scope; its result type is inferred by Node.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const read = (file) => readFile(path.join(root, file), 'utf8')
const [
  primitives,
  desktop,
  permission,
  project,
  workModes,
  skills,
  capability,
  projectWiki,
  webSearch,
  advanced,
  extension,
  plugin,
  provider,
  mcp,
  accounts,
  shortcuts,
  petEditor,
  petList,
  stylesheet
] = await Promise.all([
  read('src/renderer/src/components/settings/settings-primitives.tsx'),
  read('src/renderer/src/components/settings/DesktopAutomationPanel.tsx'),
  read('src/renderer/src/components/settings/PermissionPanel.tsx'),
  read('src/renderer/src/components/settings/ProjectIntelligenceDashboard.tsx'),
  read('src/renderer/src/components/settings/WorkModesPanel.tsx'),
  read('src/renderer/src/components/settings/SkillsMarketPanel.tsx'),
  read('src/renderer/src/components/settings/CapabilityCenterPanel.tsx'),
  read('src/renderer/src/components/settings/ProjectWikiPanel.tsx'),
  read('src/renderer/src/components/settings/WebSearchPanel.tsx'),
  read('src/renderer/src/components/settings/AdvancedSettingsPanel.tsx'),
  read('src/renderer/src/components/settings/ExtensionPanel.tsx'),
  read('src/renderer/src/components/settings/PluginPanel.tsx'),
  read('src/renderer/src/components/settings/ProviderPanel.tsx'),
  read('src/renderer/src/components/settings/McpPanel.tsx'),
  read('src/renderer/src/components/settings/AccountListEditor.tsx'),
  read('src/renderer/src/components/settings/KeyboardShortcutsDialog.tsx'),
  read('src/renderer/src/components/settings/pet/PetEditorDialog.tsx'),
  read('src/renderer/src/components/settings/pet/PetListTab.tsx'),
  read('src/renderer/src/assets/main.css')
])
for (const symbol of [
  'SettingsPageHeader',
  'SettingsSectionCard',
  'SettingsField',
  'SettingsEmptyState'
]) {
  assert.ok(primitives.includes(`function ${symbol}`), `missing ${symbol}`)
}
for (const [name, source] of [
  ['desktop', desktop],
  ['permission', permission],
  ['project intelligence', project],
  ['work modes', workModes],
  ['skills market', skills],
  ['web search', webSearch],
  ['advanced', advanced]
]) {
  // Recording controls use a compact rhythm so the safety notice and start action fit together.
  const hasPanelRhythm =
    source.includes('SETTINGS_PANEL_CLASS') ||
    (name === 'desktop' &&
      source.includes('SettingsSectionCard') &&
      source.includes('SettingsSafetyNotice'))
  assert.ok(hasPanelRhythm, `${name} must use the standard panel rhythm`)
  assert.ok(source.includes('SettingsPageHeader'), `${name} must use the standard page header`)
}
assert.ok(!desktop.includes('text-xl'), 'desktop automation must not use an oversized page title')
assert.ok(!projectWiki.includes('text-xl'), 'embedded project wiki must use a section heading')
assert.ok(
  capability.includes('SettingsPageHeader'),
  'capability center must use the standard page header'
)
assert.ok(
  !capability.includes('defaultValue'),
  'capability center display text must come from locale resources'
)
assert.ok(
  !skills.includes('defaultValue'),
  'skills market must not supply user-visible fallback text'
)
assert.ok(
  !workModes.includes('defaultValue'),
  'work modes must not supply user-visible fallback text'
)
assert.ok(
  !extension.includes('defaultValue'),
  'extensions must not supply user-visible fallback text'
)
assert.ok(
  !permission.includes('className="font-medium"'),
  'permission section headings must declare the standard size'
)
for (const [name, source, expected] of [
  ['provider', provider, 3],
  ['MCP', mcp, 1],
  ['account', accounts, 1],
  ['shortcuts', shortcuts, 1],
  ['pet editor', petEditor, 2],
  ['pet list', petList, 2]
]) {
  assert.equal(
    source.match(/<DialogContent className="settings-dialog /g)?.length,
    expected,
    `${name} dialogs must opt into portal typography`
  )
}
assert.ok(
  stylesheet.includes(".settings-dialog [class~='text-[11px]']") &&
    stylesheet.includes("body:has(.settings-page) [data-slot='select-content']"),
  'settings typography must cover provider and select portals'
)
assert.ok(
  /<PopoverContent\s+className="settings-menu /.test(plugin) &&
    provider.includes('<ContextMenuContent className="settings-menu ') &&
    stylesheet.includes(".settings-menu [class~='text-[10px]']"),
  'settings menu typography must cover popover and context-menu portals'
)
console.log('settings visual contract verification passed')
