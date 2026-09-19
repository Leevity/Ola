import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS_PAGE_ID,
  SETTINGS_REGISTRY,
  getSettingsPage
} from '../src/renderer/src/components/settings/settings-registry.ts'
import {
  buildPetStudioRoute,
  buildSettingsRoute,
  buildUsageRoute,
  parseSettingsDestination,
  parseSettingsRoute
} from '../src/renderer/src/lib/settings-route.ts'
for (const page of SETTINGS_REGISTRY) {
  const route = buildSettingsRoute(page.id)
  const parsed = parseSettingsRoute(route)
  assert.equal(parsed?.tab, page.id, `round trip tab: ${page.id}`)
  assert.equal(parsed?.section, page.section, `round trip section: ${page.id}`)
  assert.equal(parsed?.canonicalHash, route, `canonical route: ${page.id}`)
  assert.equal(getSettingsPage(page.id)?.component, page.component, `component: ${page.id}`)
}
assert.equal(parseSettingsRoute('#/settings/provider')?.tab, 'provider')
assert.equal(parseSettingsRoute('#/settings/ai-models')?.tab, 'provider')
assert.equal(parseSettingsRoute('#/settings/execution-security')?.tab, 'permission')
assert.equal(parseSettingsRoute('#/settings/capabilities')?.tab, 'plugin')
assert.equal(parseSettingsDestination('#/settings/data-usage'), 'usage')
assert.equal(parseSettingsRoute('#/settings/ai-models/model')?.tab, 'model')
assert.equal(
  parseSettingsRoute('#/settings/execution-security/desktopAutomation')?.tab,
  'desktopAutomation'
)
assert.equal(parseSettingsRoute('#/settings/wiki')?.tab, 'projectIntelligence')
assert.equal(parseSettingsRoute('#/settings/hooks')?.tab, 'advanced')
assert.equal(parseSettingsRoute('#/settings/aiCoding')?.tab, 'advanced')
assert.equal(parseSettingsDestination('#/settings/analytics'), 'usage')
assert.equal(parseSettingsDestination('#/settings/pet'), 'petStudio')
assert.equal(buildUsageRoute(), '#/usage')
assert.equal(buildPetStudioRoute(), '#/pet-studio')
assert.equal(parseSettingsRoute('#/settings/not-a-page')?.tab, DEFAULT_SETTINGS_PAGE_ID)
assert.equal(parseSettingsRoute('#/chat'), null)
console.log('settings-routes verification passed')
