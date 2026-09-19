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
  extension
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
  read('src/renderer/src/components/settings/ExtensionPanel.tsx')
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
  assert.ok(source.includes('SETTINGS_PANEL_CLASS'), `${name} must use the standard panel rhythm`)
  assert.ok(source.includes('SettingsPageHeader'), `${name} must use the standard page header`)
}
assert.ok(!desktop.includes('text-xl'), 'desktop automation must not use an oversized page title')
assert.ok(!projectWiki.includes('text-xl'), 'embedded project wiki must use a section heading')
assert.ok(
  capability.includes('SettingsPageHeader'),
  'capability center must use the standard page header'
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
console.log('settings visual contract verification passed')
