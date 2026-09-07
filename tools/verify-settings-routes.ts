import assert from 'node:assert/strict'
import { buildSettingsRoute, parseSettingsRoute } from '../src/renderer/src/lib/settings-route.ts'

assert.equal(buildSettingsRoute('general'), '#/settings/general')
assert.equal(buildSettingsRoute('provider'), '#/settings/ai-models')
assert.equal(buildSettingsRoute('model'), '#/settings/ai-models/model')
assert.equal(buildSettingsRoute('permission'), '#/settings/execution-security')
assert.equal(buildSettingsRoute('plugin'), '#/settings/capabilities')
assert.equal(buildSettingsRoute('memory'), '#/settings/personalization')
assert.equal(buildSettingsRoute('analytics'), '#/settings/data-usage')

const modelRoute = parseSettingsRoute('#/settings/ai-models/model')
assert.equal(modelRoute?.tab, 'model')
assert.equal(modelRoute?.section, 'ai-models')
assert.equal(modelRoute?.canonicalHash, '#/settings/ai-models/model')

const legacyRoute = parseSettingsRoute('#/settings/desktopAutomation')
assert.equal(legacyRoute?.tab, 'desktopAutomation')
assert.equal(legacyRoute?.section, 'execution-security')
assert.equal(legacyRoute?.canonicalHash, '#/settings/execution-security/desktopAutomation')

const mismatchedNestedRoute = parseSettingsRoute('#/settings/capabilities/model')
assert.equal(mismatchedNestedRoute?.tab, 'plugin')
assert.equal(mismatchedNestedRoute?.canonicalHash, '#/settings/capabilities')

const invalidRoute = parseSettingsRoute('#/settings/not-a-section')
assert.equal(invalidRoute?.tab, 'general')
assert.equal(invalidRoute?.canonicalHash, '#/settings/general')
assert.equal(parseSettingsRoute('#/chat'), null)

console.log('settings-routes verification passed')
