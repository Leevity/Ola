import assert from 'node:assert/strict'
import path from 'node:path'

import type { ExtensionManifest } from '../src/shared/extension-types.ts'
import {
  capabilityEscalated,
  capabilityFingerprint,
  declaredCapabilities,
  grantCapability,
  hasCapability,
  isPrivateHostLiteral,
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
// Shrinking the required set is not an escalation.
assert.equal(capabilityEscalated(['network.request', 'process'], ['network.request']), false)

// --- Approval fingerprint covers scope beyond the required set ---

const manifestFor = (
  permissions: ExtensionManifest['permissions'],
  tools: ExtensionManifest['tools'] = []
): ExtensionManifest => ({
  schemaVersion: 1,
  id: 'fingerprint',
  name: 'Fingerprint',
  version: '1',
  permissions,
  tools
})
const basePermissions = {
  capabilities: { required: ['network.request' as const] },
  hostPermissions: ['https://api.example.com']
}
const baseFingerprint = capabilityFingerprint(manifestFor(basePermissions))
// Optional capabilities are inert until explicitly granted, so declaring one is not escalation.
assert.equal(
  capabilityFingerprint(
    manifestFor({
      ...basePermissions,
      capabilities: { required: ['network.request' as const], optional: ['clipboard' as const] }
    })
  ),
  baseFingerprint
)
assert.equal(
  capabilityFingerprint(
    manifestFor({
      ...basePermissions,
      hostPermissions: ['https://api.example.com', 'https://other.example.com']
    })
  ) !== baseFingerprint,
  true,
  'widening host permissions must invalidate the prior approval'
)
const tool: ExtensionManifest['tools'][number] = {
  name: 'fetch',
  description: 'fetch',
  kind: 'http',
  inputSchema: {},
  http: { method: 'GET', url: 'https://api.example.com/data' }
}
assert.equal(
  capabilityFingerprint(
    manifestFor(basePermissions, [
      { ...tool, http: { method: 'GET', url: 'https://other.example.com/data' } }
    ])
  ) !== capabilityFingerprint(manifestFor(basePermissions, [tool])),
  true,
  'changing a tool URL must invalidate the prior approval'
)
assert.equal(capabilityFingerprint(manifestFor(basePermissions)), baseFingerprint)

// The fingerprint must cover every field that can widen what a tool can reach or do. Each of
// these previously stayed identical, so an upgrade could add them without re-approval.
const methodFingerprint = (overrides: Partial<typeof tool>) =>
  capabilityFingerprint(manifestFor(basePermissions, [{ ...tool, ...overrides }]))
assert.equal(
  capabilityFingerprint(manifestFor({ ...basePermissions, pathScopes: ['docs/*'] })) !==
    baseFingerprint,
  true,
  'widening path scopes must invalidate the prior approval'
)
assert.equal(
  capabilityFingerprint(
    manifestFor({ ...basePermissions, network: ['https://admin.example.com/*'] })
  ) !== baseFingerprint,
  true,
  'widening the network allowlist must invalidate the prior approval'
)
assert.equal(
  methodFingerprint({ http: { method: 'POST', url: tool.http!.url } }) !== methodFingerprint({}),
  true,
  'switching a tool to a write method must invalidate the prior approval'
)
assert.equal(
  methodFingerprint({ readOnly: true }) !== methodFingerprint({ readOnly: false }),
  true,
  'flipping readOnly must invalidate the prior approval'
)
assert.equal(
  methodFingerprint({ http: { ...tool.http!, headers: { 'x-target': '{{input.host}}' } } }) !==
    methodFingerprint({}),
  true,
  'changing request headers must invalidate the prior approval'
)
assert.equal(
  methodFingerprint({
    inputSchema: { type: 'object', properties: { host: { type: 'string' } } }
  }) !== methodFingerprint({}),
  true,
  'widening the input schema must invalidate the prior approval'
)

// --- Host permission narrowing ---

// A missing allowlist is a denial, not an implicit grant.
assert.equal(matchesHostPermission([], 'https://example.com/x'), false)
assert.equal(matchesHostPermission(['https://example.com'], 'https://example.com/x'), true)
assert.equal(matchesHostPermission(['https://*.example.com'], 'https://sub.example.com/x'), true)
assert.equal(matchesHostPermission(['https://example.com'], 'http://example.com/x'), false)
assert.equal(matchesHostPermission(['https://example.com'], 'https://other.com/x'), false)
// Private / loopback hosts are rejected by literal.
assert.equal(matchesHostPermission(['https://localhost'], 'https://localhost/x'), false)
assert.equal(matchesHostPermission(['https://10.0.0.5'], 'https://10.0.0.5/x'), false)
assert.equal(matchesHostPermission(['https://127.0.0.1'], 'https://127.0.0.1/x'), false)
// The declared scheme is authoritative: http declarations must authorize http targets, and
// `*://` covers both, so an http-only extension is not denied wholesale.
assert.equal(
  matchesHostPermission(['http://plain.example.com'], 'http://plain.example.com/x'),
  true
)
assert.equal(
  matchesHostPermission(['http://plain.example.com'], 'https://plain.example.com/x'),
  false
)
assert.equal(matchesHostPermission(['*://dual.example.com'], 'http://dual.example.com/x'), true)
assert.equal(matchesHostPermission(['*://dual.example.com'], 'https://dual.example.com/x'), true)
// A private host stays denied unless the caller established an explicit grant.
assert.equal(
  matchesHostPermission(['http://127.0.0.1:8080'], 'http://127.0.0.1:8080/x', {
    allowPrivateHosts: true
  }),
  true
)
// Alternate IPv4 spellings must not bypass the private-host check.
assert.equal(isPrivateHostLiteral('0.0.0.0'), true)
assert.equal(isPrivateHostLiteral('[::]'), true)
assert.equal(isPrivateHostLiteral('0x7f.0.0.1'), true)
assert.equal(isPrivateHostLiteral('2130706433'), true)
assert.equal(isPrivateHostLiteral('example.com'), false)

// --- Path narrowing (comparisons are OS-separator aware) ---

const workspaceRoot = path.resolve('workspace')
assert.equal(narrowWorkspacePath(workspaceRoot, 'docs/a.md'), path.join('docs', 'a.md'))
// `docs/../secret` resolves back inside the workspace; only `..` escapes.
assert.equal(narrowWorkspacePath(workspaceRoot, 'docs/../secret'), 'secret')
assert.equal(narrowWorkspacePath(workspaceRoot, '../secret'), null)
// An absolute path is rejected on every platform. Build it from the platform's
// own root so the assertion does not depend on POSIX/Windows path grammar.
const absoluteOutside = path.resolve(path.parse(process.cwd()).root, 'outside-secret')
assert.equal(narrowWorkspacePath(workspaceRoot, absoluteOutside), null)
// A drive-letter string is absolute only on Windows. On POSIX it is a legal
// relative path, so it resolves *inside* the workspace and cannot escape.
assert.equal(
  narrowWorkspacePath(workspaceRoot, 'C:/outside'),
  process.platform === 'win32' ? null : 'C:/outside'
)

console.log('extension capability gates verification passed')
