import assert from 'node:assert/strict'
import path from 'node:path'

import {
  capabilityEscalated,
  declaredCapabilities,
  grantCapability,
  hasCapability,
  matchesHostPermission,
  narrowWorkspacePath,
  projectedCapabilities,
  revokeCapability
} from '../src/shared/extension-capabilities.ts'
import { parseExtensionManifest } from '../src/main/extensions/extension-manifest.ts'

// --- Capability declaration + projection ---

const legacyManifest = parseExtensionManifest({
  schemaVersion: 1,
  id: 'legacy',
  name: 'Legacy',
  version: '1',
  permissions: { network: ['https://api.example.com/*'] },
  tools: [{ name: 'fetch', kind: 'http', http: { url: 'https://api.example.com/data' } }]
})
const projection = projectedCapabilities(legacyManifest)
assert.deepEqual(projection.declaration?.required, ['network.request'])
assert.deepEqual(projection.hostPermissions, ['https://api.example.com/*'])
// The on-disk manifest must be untouched (projection is read-time only).
assert.deepEqual(legacyManifest.permissions?.network, ['https://api.example.com/*'])

// --- declared / has / grant / revoke within bound ---

const declared = declaredCapabilities({
  permissions: {
    capabilities: { required: ['network.request'], optional: ['clipboard', 'window.notify'] }
  }
})
assert.deepEqual(declared, ['network.request', 'clipboard', 'window.notify'])

assert.equal(hasCapability(['network.request'], 'network.request'), true)
assert.equal(hasCapability([], 'network.request'), false)

const grantInside = grantCapability(
  { required: ['network.request'], optional: ['clipboard'] },
  [],
  ['clipboard']
)
assert.equal(grantInside.ok, true)
assert.deepEqual(grantInside.granted, ['clipboard'])

// Granting a kind outside the declared bound fails closed — no dialog, no grant.
const grantOutside = grantCapability({ required: ['network.request'] }, [], ['process'])
assert.equal(grantOutside.ok, false)
assert.deepEqual(grantOutside.granted, [])

const afterRevoke = revokeCapability(['network.request', 'clipboard'], ['clipboard'])
assert.deepEqual(afterRevoke, ['network.request'])

// --- Escalation: only the required set is compared; undefined = first install ---

assert.equal(capabilityEscalated(undefined, ['network.request']), false)
assert.equal(capabilityEscalated(['network.request'], ['network.request']), false)
assert.equal(capabilityEscalated(['network.request'], ['network.request', 'process']), true)
// Adding an optional capability is NOT escalation (only required growth matters).
assert.equal(capabilityEscalated(['network.request'], ['network.request']), false)

// --- Host permission narrowing ---

assert.equal(matchesHostPermission([], 'https://example.com/x'), true)
assert.equal(matchesHostPermission(['https://example.com'], 'https://example.com/x'), true)
assert.equal(matchesHostPermission(['https://*.example.com'], 'https://sub.example.com/x'), true)
assert.equal(matchesHostPermission(['https://example.com'], 'http://example.com/x'), false)
assert.equal(matchesHostPermission(['https://example.com'], 'https://other.com/x'), false)
// Private / loopback hosts are rejected by literal.
assert.equal(matchesHostPermission(['https://localhost'], 'https://localhost/x'), false)
assert.equal(matchesHostPermission(['https://10.0.0.5'], 'https://10.0.0.5/x'), false)
assert.equal(matchesHostPermission(['https://127.0.0.1'], 'https://127.0.0.1/x'), false)

// --- Path narrowing (comparisons are OS-separator aware) ---

assert.equal(narrowWorkspacePath('C:/ws', 'docs/a.md'), path.join('docs', 'a.md'))
// `docs/../secret` resolves back inside the workspace; only `..` escapes.
assert.equal(narrowWorkspacePath('C:/ws', 'docs/../secret'), 'secret')
assert.equal(narrowWorkspacePath('C:/ws', '../secret'), null)
assert.equal(narrowWorkspacePath('C:/ws', 'C:/outside'), null)
assert.equal(narrowWorkspacePath('C:/ws', '/absolute'), null)

console.log('extension capability gates verification passed')
