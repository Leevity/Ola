// ── MCP external tool naming & exposure policy ──
//
// Pure and dependency-free on purpose: Main, the renderer, the runtime and the tests all compute
// the *same* external name from the *same* inputs. A stateful allocator cannot do that — its
// collision suffix would depend on which tools happened to be enumerated first, so editing one
// server's allowlist could rename an unrelated tool and break transcripts. The renderer feeds
// `run.toolNames` and Main answers from `selectExplicitTools`, which matches names exactly: any
// divergence makes a connected tool silently disappear.

import { fnv1a32, sanitizeToolName, TOOL_NAME_MAX } from './tool-naming'

export const MCP_TOOL_NAME_PREFIX = 'mcp__'
/** Server namespace. Deliberately `_`-free so the first `__` after the prefix is the separator. */
export const MCP_ALIAS_MAX = 12
/**
 * Segment budget left by the *longest* legal alias: `64 - 5 - 2 - 12 = 45`. Shorter aliases get
 * more room, which `mcpExternalToolName` passes as a per-call budget; a fixed 47 would have made
 * `mcp__<12-char alias>__<46-char tool>` exceed `TOOL_NAME_MAX` and fail as `TOO_LONG`.
 */
export const MCP_TOOL_SEGMENT_MAX = TOOL_NAME_MAX - MCP_TOOL_NAME_PREFIX.length - 2 - MCP_ALIAS_MAX
/** Per-server exposure ceiling; the run-wide ceiling stays `MCP_RUN_TOOL_BUDGET`. */
export const MCP_EXPOSED_TOOLS_MAX_PER_SERVER = 32
/** Mirrors the `run.toolNames` cap enforced by `parseRunSpec`. */
export const MCP_RUN_TOOL_BUDGET = 128

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,11}$/

export interface McpExposurePolicy {
  enabledTools?: string[]
  toolPresets?: Record<string, string[]>
  activePreset?: string
}

/**
 * A host-side gate run before the child process is spawned. `fail-open` on anything unparsable is
 * deliberate: a preflight that cannot read its probe output must not be treated as a negative
 * answer, because that would make an unrelated shell quirk look like an unsupported runtime.
 */
export interface McpPreflightConfig {
  /** Interpreter or launcher the stdio child will actually use. Never inferred from `process.version`. */
  nodeCommand?: string
  /** `package.json`-style range, matched by the dependency-free `matchesNodeRange`. */
  nodeRange?: string
  /** Executables the server shells out to. Absent entries block connecting; missing ones are reported. */
  requiredCommands?: string[]
}

/** Caps for one tool result, in bytes, checked before the value reaches the model. */
export interface McpOutputLimits {
  /** Above this size a text block is spilled to a managed file instead of being returned inline. */
  inlineTextBytes?: number
  /** Hard ceiling for the whole (possibly reduced) result; beyond it the call fails. */
  maxResultBytes?: number
}

export type McpExternalNameReason = 'INVALID_ALIAS' | 'EMPTY_TOOL_NAME' | 'TOO_LONG'

export interface McpExternalNameResult {
  name: string
  ok: boolean
  reason?: McpExternalNameReason
  /** True when the advertised name did not fit the segment budget and was elided. */
  elided?: boolean
}

/** Whether `value` is a canonical MCP alias (lowercase, digits, hyphens, ≤ `MCP_ALIAS_MAX`). */
export function isMcpToolAlias(value: string): boolean {
  return ALIAS_PATTERN.test(value)
}

/**
 * Sanitize one tool name into the external segment. Over-length names get a stable
 * `head_fnv1a32` tail instead of being truncated, so two long names sharing a prefix stay distinct.
 *
 * `budget` is the room left by the alias actually in use; it defaults to the worst-case floor so a
 * caller that has not assembled a name yet still cannot produce a segment that overflows later.
 */
export function sanitizeMcpToolSegment(
  raw: string,
  budget: number = MCP_TOOL_SEGMENT_MAX
): { segment: string; elided: boolean } {
  // Sanitizing collapses illegal characters and runs of underscores, so it is the *cleaned* length
  // that has to clear the budget. A 60-char name of only dots can legally shrink below it.
  const whole = sanitizeToolName(raw, raw.length)
  if (whole.length <= budget) return { segment: whole, elided: false }
  const headMax = budget - 9 // head + `_` + the 8-char FNV tail
  if (headMax < 1) return { segment: whole.slice(0, Math.max(budget, 0)), elided: true }
  return { segment: `${whole.slice(0, headMax)}_${fnv1a32(raw)}`, elided: true }
}

/**
 * The single external name for one MCP tool. `alias` is assigned once per server and never
 * recomputed, and the segment is a pure function of the tool name the server advertises, so the
 * result is reproducible across processes and restarts.
 */
export function mcpExternalToolName(alias: string, toolName: string): McpExternalNameResult {
  if (!isMcpToolAlias(alias)) {
    return { name: '', ok: false, reason: 'INVALID_ALIAS' }
  }
  const raw = typeof toolName === 'string' ? toolName.trim() : ''
  if (!raw) return { name: '', ok: false, reason: 'EMPTY_TOOL_NAME' }
  const budget = TOOL_NAME_MAX - MCP_TOOL_NAME_PREFIX.length - 2 - alias.length
  const { segment, elided } = sanitizeMcpToolSegment(raw, budget)
  const name = `${MCP_TOOL_NAME_PREFIX}${alias}__${segment}`
  if (name.length > TOOL_NAME_MAX) {
    return { name, ok: false, reason: 'TOO_LONG' }
  }
  return { name, ok: true, elided }
}

/** Convenience wrapper for call sites that only need the string. */
export function mcpExternalToolNameString(alias: string, toolName: string): string | undefined {
  const result = mcpExternalToolName(alias, toolName)
  return result.ok ? result.name : undefined
}

export interface ParsedMcpExternalName {
  alias: string
  toolSegment: string
  /** Legacy names embed a 21-char nanoid, which may contain `_` and can be longer than an alias. */
  legacy: boolean
}

/**
 * Decode an external MCP tool name. Canonical aliases never contain `_`, so the first `__` after
 * the prefix is unambiguous even when the tool segment itself contains `__` (that is what the
 * resource convention `mcp__<alias>__resource__<name>` relies on). Falls back to the legacy
 * `mcp__<serverId>__<tool>` shape so historical transcripts still render.
 */
export function parseMcpExternalToolName(name: string): ParsedMcpExternalName | null {
  if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return null
  const rest = name.slice(MCP_TOOL_NAME_PREFIX.length)
  const separator = rest.indexOf('__')
  if (separator <= 0) return null
  const head = rest.slice(0, separator)
  const toolSegment = rest.slice(separator + 2)
  if (!toolSegment) return null
  return { alias: head, toolSegment, legacy: !isMcpToolAlias(head) }
}

/**
 * Resolve the model-facing tool set for one server.
 *
 * `null` means "unfiltered" — the legacy behaviour for every config that predates the allowlist.
 * An empty array is the opposite: expose nothing. The distinction is load-bearing, so absent is
 * never coerced to `[]` (same semantics as extension approvals' `granted?: string[]`).
 */
export function resolveMcpEffectiveToolNames(policy?: McpExposurePolicy): Set<string> | null {
  if (!policy) return null
  const hasAllowlist = Array.isArray(policy.enabledTools)
  const preset =
    policy.activePreset && policy.toolPresets ? policy.toolPresets[policy.activePreset] : undefined
  const hasPreset = Array.isArray(preset)
  if (!hasAllowlist && !hasPreset) return null

  const names = new Set<string>()
  if (hasAllowlist) for (const name of policy.enabledTools ?? []) addToolName(names, name)
  if (hasPreset) for (const name of preset ?? []) addToolName(names, name)
  return names
}

function addToolName(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (trimmed) target.add(trimmed)
}

/** Normalized, deduplicated allowlist. Non-array input stays `undefined` = "absent". */
export function normalizeMcpToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const names = new Set<string>()
  for (const item of value) addToolName(names, item)
  return [...names]
}

/** Normalized presets; each value follows the same absent-vs-empty rule as `normalizeMcpToolNames`. */
export function normalizeMcpToolPresets(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const presets: Record<string, string[]> = {}
  for (const [key, names] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeMcpToolNames(names)
    const alias = key.trim()
    if (!alias || !normalized) continue
    presets[alias] = normalized
  }
  return presets
}

/**
 * Derive a stable alias for a stored server that predates `toolAlias`. Derived from the immutable
 * `id` only: `name` is user-editable and the panel debounces those edits into `mcp:update`, so
 * seeding from the label would rename live tool identities.
 */
export function deriveMcpToolAlias(id: string, name?: string, taken?: ReadonlySet<string>): string {
  const used = taken ?? new Set<string>()
  const slug = sanitizeToolAlias(name ?? '')
  if (slug && !used.has(slug)) return slug
  const hashed = `mcp${fnv1a32(id).slice(0, MCP_ALIAS_MAX - 3)}`
  if (!used.has(hashed)) return hashed
  for (let index = 1; index < 1000; index += 1) {
    const candidate = sanitizeToolAlias(`${hashed}${index}`, MCP_ALIAS_MAX)
    if (candidate && !used.has(candidate)) return candidate
  }
  return hashed
}

/**
 * How many tools one policy would expose. `null` = unfiltered, which is not zero: a server with no
 * allowlist still advertises its full tool set and therefore consumes real run budget.
 */
export function mcpExposureSize(policy: McpExposurePolicy | undefined): number | null {
  const effective = resolveMcpEffectiveToolNames(policy)
  return effective ? effective.size : null
}

/**
 * Reject a policy that would exceed the per-server ceiling. The count is the union of the
 * allowlist and the active preset, because both feed exposure; validating them separately would
 * let two half-full lists combine past the cap.
 */
export function validateMcpExposure(
  policy: McpExposurePolicy | undefined,
  max: number = MCP_EXPOSED_TOOLS_MAX_PER_SERVER
): { ok: true; size: number | null } | { ok: false; error: string; size: number } {
  const size = mcpExposureSize(policy)
  if (size !== null && size > max) {
    return {
      ok: false,
      size,
      error: `Too many exposed MCP tools: ${size} exceeds the ${max} per-server limit.`
    }
  }
  return { ok: true, size }
}

/** Coerce arbitrary text into a legal alias, or `''` when nothing usable remains. */
export function sanitizeToolAlias(value: string, max: number = MCP_ALIAS_MAX): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  if (!cleaned || !/^[a-z]/.test(cleaned)) return ''
  return isMcpToolAlias(cleaned) ? cleaned : ''
}

/**
 * Derive the model-facing set for one server from what it advertises plus the exposure policy.
 * Kept pure and in one place because three consumers need the same answer: the runtime tool
 * registry, the renderer's tool list, and the panel that has to explain any gap between the two.
 *
 * A tool whose external name cannot be formed is returned with `externalName` absent and `reason`
 * set, never omitted: a silently missing tool is the bug this whole module exists to fix.
 */
export function buildExposedMcpTools(
  alias: string,
  tools: readonly {
    name: string
    description?: string
    inputSchema?: Record<string, unknown>
  }[],
  policy?: McpExposurePolicy
): { exposed: ExposedMcpTool[]; names: Set<string>; unexposable: number } {
  const effective = resolveMcpEffectiveToolNames(policy)
  const exposed: ExposedMcpTool[] = []
  const names = new Set<string>()
  let unexposable = 0
  const claimed = new Set<string>()

  for (const tool of tools) {
    const entry: ExposedMcpTool = {
      name: tool.name,
      alias,
      description: tool.description
    }
    if (effective && !effective.has(tool.name)) {
      // Only a registerable tool crosses the boundary with a schema. A 229-tool catalog would
      // otherwise ship 197 schemas that no caller can use, next to the same names already in
      // `McpServerInfo.tools`.
      exposed.push({ ...entry, filtered: true })
      continue
    }
    const named = mcpExternalToolName(alias, tool.name)
    if (!named.ok) {
      unexposable += 1
      exposed.push({ ...entry, reason: named.reason })
      continue
    }
    // Two advertised names that sanitize onto the same segment cannot both be registered; the
    // duplicate is reported rather than dropped so the panel can say which one is missing.
    if (claimed.has(named.name)) {
      unexposable += 1
      exposed.push({ ...entry, reason: 'TOO_LONG' })
      continue
    }
    claimed.add(named.name)
    exposed.push({
      ...entry,
      inputSchema: tool.inputSchema,
      externalName: named.name,
      elided: named.elided,
      reason: undefined
    })
    names.add(named.name)
  }
  return { exposed, names, unexposable }
}

/** Names the server advertises that the allowlist asks for but does not have. */
export function findUnknownEnabledToolNames(
  policy: McpExposurePolicy | undefined,
  advertised: readonly string[]
): string[] {
  const effective = resolveMcpEffectiveToolNames(policy)
  if (!effective) return []
  const available = new Set(advertised)
  return [...effective].filter((name) => !available.has(name))
}

/**
 * Why a server refused to start. Carried as a side channel on `McpServerInfo` rather than a new
 * `McpServerStatus` member: every existing consumer switch treats status as a connection state, so
 * a new enum value would silently fall into default branches across the panel, store and tests.
 */
export type McpDiagnosticCode =
  | 'NODE_VERSION_UNSUPPORTED'
  | 'COMMAND_MISSING'
  | 'ENGINE_MISSING'
  | 'TOOL_NOT_EXPOSABLE'

export interface McpServerDiagnostic {
  code: McpDiagnosticCode
  /** What the probe actually saw, e.g. `v25.6.1`. Never a secret; never localized. */
  detail?: string
  /** One actionable step, e.g. `install Node 24.22.1 or newer`. */
  hint?: string
  /** Tools advertised by the server but dropped because their external name is illegal. */
  unexposableToolCount?: number
}

/**
 * What a server advertises, stripped of anything usable: no schema and no external name, so a
 * caller cannot register a tool Main did not expose. Both sides of the IPC boundary read this
 * shape, so it lives here rather than in a Main-only module.
 */
export interface AdvertisedMcpTool {
  name: string
  description?: string
}

/**
 * One tool the model may actually call, already carrying its external name. Main computes this so
 * the renderer never re-derives a name from a server id and a tool name — that divergence is
 * exactly how a connected tool used to vanish from a run without any error.
 */
export interface ExposedMcpTool {
  /** Name as advertised by the server. */
  name: string
  /** Model-facing `mcp__<alias>__<segment>`. Absent only when `reason` explains why it is illegal. */
  externalName?: string
  description?: string
  inputSchema?: Record<string, unknown>
  alias: string
  /** True when the advertised name was elided into a hashed segment. */
  elided?: boolean
  reason?: McpExternalNameReason
  /** Excluded by the allowlist rather than by a naming failure. */
  filtered?: boolean
}
