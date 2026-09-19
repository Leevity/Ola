import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const [registry, resolver, settingsPage] = await Promise.all([
  readFile(path.join(root, 'src/renderer/src/components/settings/settings-registry.ts'), 'utf8'),
  readFile(
    path.join(root, 'src/renderer/src/components/settings/settings-panel-resolver.tsx'),
    'utf8'
  ),
  readFile(path.join(root, 'src/renderer/src/components/settings/SettingsPage.tsx'), 'utf8')
])

assert.ok(registry.includes('SETTINGS_REGISTRY'), 'settings registry is missing')
assert.ok(registry.includes('SETTINGS_SECTIONS'), 'settings sections are missing')
assert.ok(
  !settingsPage.includes('const menuGroupDefs'),
  'SettingsPage must not own menu definitions'
)
assert.ok(
  !settingsPage.includes('normalizeSettingsTab'),
  'SettingsPage must not own legacy aliases'
)
assert.ok(!settingsPage.includes('const panelMap'), 'SettingsPage must not own panel dispatch')
assert.ok(settingsPage.includes('getPagesForSection'), 'menu must be registry-driven')
assert.ok(
  settingsPage.includes('renderSettingsPanel'),
  'panel dispatch must use the shared resolver'
)
assert.ok(
  resolver.includes('EXTERNAL_PANEL_BINDINGS'),
  'settings panel resolver is missing bindings'
)
assert.ok(!registry.includes("id: 'aiCoding'"), 'disabled AI Coding cannot be visible')
assert.ok(!registry.includes("id: 'hooks'"), 'disabled Hooks cannot be visible')
for (const section of [
  'common',
  'models',
  'execution',
  'integrations',
  'personalization',
  'advanced'
]) {
  assert.ok(registry.includes(`id: '${section}'`), `missing settings section: ${section}`)
}
console.log('settings registry verification passed')
