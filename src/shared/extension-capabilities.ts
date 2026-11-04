/**
 * Pure capability-gate functions for the extension system. Zero Electron imports so the
 * module can be unit-tested and reused by any runtime.
 *
 * Layering (per the host-extension permission model): the capability gate answers "may this
 * extension use this capability family at all?" — declared as an upper bound in the manifest
 * and granted per-extension by the user. The per-call tool whitelist in permission-policy.ts
 * answers "does this single call need a confirmation dialog?". Both chains must pass; a
 * capability grant never bypasses the tool whitelist.
 */

import path from 'node:path'
import type {
  ExtensionCapabilityDeclaration,
  ExtensionCapabilityKind,
  ExtensionManifest
} from './extension-types'

/** Conservative tool-name → capability-family mapping for extension tools. */
export function capabilityForTool(
  toolName: string,
  effect: 'read' | 'write'
): ExtensionCapabilityKind {
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'network.request'
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') return 'filesystem.read'
  if (toolName === 'Write' || toolName === 'Edit') return 'filesystem.write'
  if (toolName === 'Bash' || toolName === 'Shell') return 'process'
  // Unknown mutating tools default conservatively to the extension-tool family.
  return effect === 'read' ? 'agent.context' : 'agent.tool'
}

/** Union of declared required and optional capabilities = the audited upper bound. */
export function declaredCapabilities(
  manifest: Pick<ExtensionManifest, 'permissions'>
): ExtensionCapabilityKind[] {
  const declaration = manifest.permissions?.capabilities
  if (!declaration) return []
  return [...new Set([...declaration.required, ...(declaration.optional ?? [])])]
}

/** The capabilities the extension requires just to be installed and run. */
export function requiredCapabilities(
  manifest: Pick<ExtensionManifest, 'permissions'>
): ExtensionCapabilityKind[] {
  return [...new Set(manifest.permissions?.capabilities?.required ?? [])]
}

/** Legacy projection: `permissions.network` migrates to a required network.request capability. */
export function projectedCapabilities(manifest: Pick<ExtensionManifest, 'permissions'>): {
  declaration: ExtensionCapabilityDeclaration | undefined
  hostPermissions: string[]
} {
  const permissions = manifest.permissions
  const hostPermissions = [...new Set(permissions?.hostPermissions ?? permissions?.network ?? [])]
  const declaration = permissions?.capabilities
  if (declaration) return { declaration, hostPermissions }
  const network = permissions?.network
  if (network && network.length) {
    return {
      declaration: { required: ['network.request'], ...(permissions?.capabilities ?? {}) },
      hostPermissions
    }
  }
  return { declaration: undefined, hostPermissions }
}

export function hasCapability(
  granted: readonly ExtensionCapabilityKind[],
  kind: ExtensionCapabilityKind
): boolean {
  return granted.includes(kind)
}

function normalizeKinds(value: readonly ExtensionCapabilityKind[]): ExtensionCapabilityKind[] {
  return [...new Set(value)]
}

/**
 * Grant capabilities, but only within the declared upper bound. A request for a kind that was
 * not declared fails closed (no dialog) so the audited surface always equals the obtainable one.
 */
export function grantCapability(
  declaration: ExtensionCapabilityDeclaration | undefined,
  granted: readonly ExtensionCapabilityKind[],
  kinds: readonly ExtensionCapabilityKind[]
): { granted: ExtensionCapabilityKind[]; ok: boolean } {
  const bound = new Set(
    declaration ? declaredCapabilities({ permissions: { capabilities: declaration } }) : []
  )
  const requested = normalizeKinds(kinds)
  if (requested.some((kind) => !bound.has(kind))) return { granted: [...granted], ok: false }
  return { granted: normalizeKinds([...granted, ...requested]), ok: true }
}

/** Revoke capabilities; kinds outside the current grant are simply ignored. */
export function revokeCapability(
  granted: readonly ExtensionCapabilityKind[],
  kinds: readonly ExtensionCapabilityKind[]
): ExtensionCapabilityKind[] {
  const revokeSet = new Set(normalizeKinds(kinds))
  return granted.filter((kind) => !revokeSet.has(kind))
}

/**
 * Whether an upgrade widens the required set beyond what was last approved. Only the required
 * (mandatory) set is compared — `approvedRequired` records what the user last approved, not the
 * full granted set, because an escalation question is about mandatory scope growth.
 * `approvedRequired === undefined` means no prior approval exists (first install).
 */
export function capabilityEscalated(
  approvedRequired: readonly ExtensionCapabilityKind[] | undefined,
  newRequired: readonly ExtensionCapabilityKind[]
): boolean {
  if (approvedRequired === undefined) return false
  const approvedSet = new Set(approvedRequired)
  return newRequired.some((kind) => !approvedSet.has(kind))
}

/**
 * Lexical host-permission match. Only https is accepted; private/loopback hosts are rejected by
 * literal only — DNS rebinding cannot be closed at the lexical layer, so this is documented as a
 * known boundary (realpath-equivalent normalization happens at the call site).
 */
export function matchesHostPermission(hostPermissions: readonly string[], url: string): boolean {
  if (!hostPermissions.length) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  if (isPrivateHostLiteral(host)) return false
  return hostPermissions.some((permission) => hostMatches(permission.toLowerCase(), host))
}

function isPrivateHostLiteral(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true
  const ipv4 = host.split('.')
  if (ipv4.length === 4 && ipv4.every((octet) => /^\d{1,3}$/.test(octet))) {
    const first = Number(ipv4[0])
    const second = Number(ipv4[1])
    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
  }
  return host === '[::1]'
}

/** One host permission pattern vs a concrete hostname. Supports `*.example.com` wildcard prefix. */
function hostMatches(permission: string, host: string): boolean {
  let allowed: URL
  try {
    allowed = new URL(permission)
  } catch {
    return false
  }
  if (allowed.protocol !== 'https:') return false
  const allowedHost = allowed.hostname.toLowerCase()
  if (allowedHost.startsWith('*.')) {
    const suffix = allowedHost.slice(1) // .example.com
    return host.endsWith(suffix)
  }
  return allowedHost === host
}

/**
 * Narrow a requested workspace path to a relative path that cannot lexically escape `root`.
 * This layer answers "does the shape look right"; symlink normalization is done at the call site
 * (see security/path-policy.ts), which owns the authoritative path boundary.
 */
export function narrowWorkspacePath(root: string, requested: string): string | null {
  if (!root || !requested || requested.includes('\0')) return null
  if (path.isAbsolute(requested)) return null
  const rootResolved = path.resolve(root)
  const candidate = path.resolve(rootResolved, requested)
  const relative = path.relative(rootResolved, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null
  return relative
}
