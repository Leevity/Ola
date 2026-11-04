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

/** Deterministic JSON so key order in a manifest can never change a fingerprint. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => JSON.stringify(key) + ':' + stableStringify(item))
  return '{' + entries.join(',') + '}'
}

/**
 * Stable fingerprint of the surface that takes effect without an explicit user grant: required
 * capabilities, both host allowlists, path scopes, and the full shape of every HTTP tool.
 * Optional capabilities are deliberately excluded — they are inert until granted, so declaring a
 * new one does not widen what the extension can actually do.
 *
 * The tool shape matters as much as its URL: `method` and `body` decide whether a tool writes,
 * `readOnly` drives effect classification, and `headers`/`inputSchema` can redirect a request to
 * a host the URL alone does not reveal. Widening any of them must re-trigger approval.
 */
export function capabilityFingerprint(
  manifest: Pick<ExtensionManifest, 'permissions' | 'tools'>
): string {
  const projection = projectedCapabilities(manifest)
  const required = [...new Set(projection.declaration?.required ?? [])].sort()
  const hosts = [...new Set(projection.hostPermissions)].sort()
  const network = [...new Set(manifest.permissions?.network ?? [])].sort()
  const pathScopes = [...new Set(manifest.permissions?.pathScopes ?? [])].sort()
  const tools = (manifest.tools ?? [])
    .map((tool) =>
      stableStringify({
        name: tool.name,
        kind: tool.kind,
        // Absent `readOnly` and an explicit `false` mean the same thing; normalise both.
        readOnly: tool.readOnly === true,
        method: tool.http?.method ?? '',
        url: tool.http?.url ?? '',
        headers: tool.http?.headers ?? {},
        body: tool.http?.body ?? null,
        schema: tool.inputSchema ?? {},
        artifact: tool.artifact ?? null
      })
    )
    .sort()
  return stableStringify({ required, hosts, network, pathScopes, tools })
}

/**
 * Lexical host-permission match. The scheme written in the permission is authoritative:
 * `https://` patterns match only https, `http://` only http, and `*://` covers both. Deriving the
 * scheme from the declaration (instead of hardcoding https) is what keeps an extension that
 * declares a plain-http target from having *every* call rejected.
 *
 * Private/loopback hosts are rejected by literal only — DNS rebinding cannot be closed at the
 * lexical layer, so this is documented as a known boundary (realpath-equivalent normalization
 * happens at the call site). `allowPrivateHosts` exists for that call site: it may only be set
 * after an explicit private-host grant has been established separately.
 *
 * An empty allowlist denies: a missing declaration is never an implicit grant.
 */
export function matchesHostPermission(
  hostPermissions: readonly string[],
  url: string,
  options: { allowPrivateHosts?: boolean } = {}
): boolean {
  if (!hostPermissions.length) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (!options.allowPrivateHosts && isPrivateHostLiteral(parsed.hostname)) return false
  return hostPermissions.some((permission) => hostMatches(permission.trim().toLowerCase(), parsed))
}

/**
 * Normalize an IPv4 host written in decimal/octal/hex or IPv4-mapped IPv6 form to its four
 * octets, so `2130706433`, `0177.0.0.1` and `::ffff:127.0.0.1` cannot slip past the private
 * range check. Returns null when the host is not an IPv4 literal.
 */
function normalizedIpv4(host: string): number[] | null {
  let candidate = host.trim().toLowerCase()
  if (candidate.startsWith('[::ffff:') && candidate.endsWith(']')) {
    candidate = candidate.slice('[::ffff:'.length, -1)
  } else if (candidate.startsWith('::ffff:')) {
    candidate = candidate.slice('::ffff:'.length)
  }
  const parts = candidate.split('.')
  if (parts.length === 1) {
    if (!/^(0x[0-9a-f]+|\d+)$/.test(parts[0])) return null
    const numeric = Number(parts[0])
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 0xffffffff) return null
    return [(numeric >>> 24) & 255, (numeric >>> 16) & 255, (numeric >>> 8) & 255, numeric & 255]
  }
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^(0x[0-9a-f]+|0[0-7]*|\d+)$/.test(part)) return null
    const numeric = part.startsWith('0x')
      ? Number.parseInt(part.slice(2), 16)
      : /^0[0-7]+$/.test(part)
        ? Number.parseInt(part, 8)
        : Number(part)
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 255) return null
    octets.push(numeric)
  }
  return octets
}

/** Literal private/loopback host check. Exported so the HTTP executor can share the policy. */
export function isPrivateHostLiteral(host: string): boolean {
  const value = host.trim().toLowerCase()
  if (
    value === 'localhost' ||
    value.endsWith('.localhost') ||
    value === '::1' ||
    value === '[::1]' ||
    value === '::' ||
    value === '[::]' ||
    value === '0.0.0.0'
  )
    return true
  const octets = normalizedIpv4(value)
  if (!octets) return false
  const [first, second] = octets
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  )
}

/**
 * One host permission pattern vs a concrete target. Supports the Chrome-style `*://host` scheme
 * wildcard (which URL() cannot parse directly) and a `*.example.com` host wildcard. An explicit
 * scheme never matches a different scheme, including https patterns against http targets.
 */
function hostMatches(permission: string, target: URL): boolean {
  const wildcardScheme = permission.startsWith('*://')
  const raw = wildcardScheme ? `https://${permission.slice('*://'.length)}` : permission
  let allowed: URL
  try {
    allowed = new URL(raw)
  } catch {
    return false
  }
  if (!wildcardScheme && allowed.protocol !== target.protocol) return false
  const host = target.hostname.toLowerCase()
  const allowedHost = allowed.hostname.toLowerCase()
  if (!allowedHost) return false
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
