/**
 * Stable, unique external tool-name assignment for the extension/MCP tool registry.
 *
 * Rationale: tool names become system-prompt text and transcript keys. Names that are too long,
 * contain illegal characters, or collide silently degrade the model (tools vanish) or break
 * transcript pairing across restarts. This module centralizes sanitization and the
 * "allocated once, never reused" invariant so the same internal id always maps to the same
 * external name — a transcript that recorded a name keeps pointing at the same tool.
 *
 * The FNV-1a hash below is deliberately hand-rolled (no node:crypto) so this module is usable
 * from any runtime and from unit tests. It has no security properties; it is only for de-duplication.
 */

export const TOOL_NAME_MAX = 64
export const DESCRIPTION_MAX = 512

// FNV-1a 32-bit offset basis and prime.
const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** FNV-1a 32-bit hash of a string, as a hex string (8 chars, zero-padded). */
export function fnv1a32(value: string): string {
  let hash = FNV_OFFSET >>> 0
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Sanitize an untrusted tool name. Whitelist `[a-zA-Z0-9_-]` only (untrusted input ⇒ a blacklist
 * is guaranteed to miss something). Illegal characters become `_`, and runs of three or more
 * underscores collapse to `__` to preserve the `mcp__server__tool` / `ext__id__tool` separators.
 */
export function sanitizeToolName(raw: string): string {
  let cleaned = ''
  for (const char of raw) {
    if (/[A-Za-z0-9_-]/.test(char)) cleaned += char
    else cleaned += '_'
  }
  // Collapse runs of 3+ underscores to a double underscore.
  cleaned = cleaned.replace(/__+/g, '__')
  // Trim leading/trailing underscores to keep the name tidy and non-empty.
  cleaned = cleaned.replace(/^_+|_+$/g, '')
  if (!cleaned) return 'tool'
  return cleaned.slice(0, TOOL_NAME_MAX)
}

/**
 * Sanitize an untrusted description for the system prompt. Strip control characters and cap the
 * length. The cap is not a poisoning defense by itself, but it stops a hostile description from
 * blowing up the context window.
 */
export function sanitizeDescription(raw: string): string {
  let cleaned = ''
  for (const char of raw) {
    const code = char.charCodeAt(0)
    // Keep printable ASCII and common whitespace; drop C0/C1 control chars.
    if (code < 32 && char !== '\n' && char !== '\t') continue
    if (code >= 0x7f && code <= 0x9f) continue
    cleaned += char
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, DESCRIPTION_MAX)
}

/**
 * Stable internal-id → external-name allocator. Names are assigned once and never reused, so a
 * name that appears in a transcript always refers to the same tool. Collisions and over-length
 * names are resolved with a `head_fnv1a32` suffix.
 */
export class ToolNamer {
  private readonly byId = new Map<string, string>()
  private readonly used = new Set<string>()

  /**
   * Assign (or return the already-assigned) external name for an internal id.
   * `desired` is the human-facing name (already sanitized by the caller or here).
   */
  nameFor(internalId: string, desired: string): string {
    const existing = this.byId.get(internalId)
    if (existing) return existing
    const base = sanitizeToolName(desired)
    let name = base
    let suffix = ''
    // Resolve collisions and over-length deterministically with the id's hash.
    const hash = fnv1a32(internalId)
    let attempts = 0
    while (this.used.has(name)) {
      attempts += 1
      suffix = `_${hash}`
      if (attempts > 1) suffix = `_${attempts}_${hash}`
      name = (base + suffix).slice(0, TOOL_NAME_MAX)
      // Guarantee the hash stays visible even when the head is long.
      if (name.length + suffix.length > TOOL_NAME_MAX) {
        const headRoom = TOOL_NAME_MAX - suffix.length
        name = base.slice(0, Math.max(headRoom, 1)) + suffix
      }
      // Never return a name that is already taken: doing so would silently alias
      // two different tools and let the model call the wrong one.
      if (attempts > 100) {
        throw new Error(`TOOL_NAME_ALLOCATION_EXHAUSTED: ${internalId}`)
      }
    }
    this.used.add(name)
    this.byId.set(internalId, name)
    return name
  }

  /** Reserve an exact external name so a tool card can render before activation. */
  reserveName(name: string): string {
    const sanitized = sanitizeToolName(name).slice(0, TOOL_NAME_MAX)
    if (!sanitized) return 'tool'
    this.used.add(sanitized)
    return sanitized
  }

  /** Whether a name has already been handed out (collision guard for diagnostics). */
  isUsed(name: string): boolean {
    return this.used.has(name)
  }
}
