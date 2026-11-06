import { describe, expect, it } from 'vitest'
import {
  MCP_ALIAS_MAX,
  MCP_EXPOSED_TOOLS_MAX_PER_SERVER,
  MCP_TOOL_SEGMENT_MAX,
  buildExposedMcpTools,
  deriveMcpToolAlias,
  findUnknownEnabledToolNames,
  isMcpToolAlias,
  mcpExposureSize,
  mcpExternalToolName,
  parseMcpExternalToolName,
  resolveMcpEffectiveToolNames,
  sanitizeMcpToolSegment,
  sanitizeToolAlias,
  validateMcpExposure
} from '../../src/shared/mcp-tool-policy'
import { TOOL_NAME_MAX } from '../../src/shared/tool-naming'

describe('mcp external tool naming', () => {
  it('fits the provider ceiling by construction for every legal alias and tool name', () => {
    const result = mcpExternalToolName('rea', 'build_reconstruction_obligation_ledger')
    expect(result.ok).toBe(true)
    expect(result.name).toBe('mcp__rea__build_reconstruction_obligation_ledger')
    expect(result.name.length).toBeLessThanOrEqual(TOOL_NAME_MAX)
  })

  it('keeps the longest REA name whole instead of clipping it', () => {
    // 38 chars + `mcp__rea__` = 48, comfortably inside 64. The old path truncated at 64 only
    // after a server id consumed 21 of them.
    const longest = 'build_reconstruction_obligation_ledger'
    expect(longest.length).toBe(38)
    expect(sanitizeMcpToolSegment(longest)).toEqual({ segment: longest, elided: false })
  })

  it('elides an over-long tool name into a stable hashed tail', () => {
    const raw = 'a'.repeat(MCP_TOOL_SEGMENT_MAX + 30)
    const first = mcpExternalToolName('rea', raw)
    const second = mcpExternalToolName('rea', raw)
    expect(first.ok).toBe(true)
    expect(first.elided).toBe(true)
    expect(first.name).toBe(second.name)
    expect(first.name.length).toBeLessThanOrEqual(TOOL_NAME_MAX)
  })

  it('keeps two long names that share a prefix distinct', () => {
    const base = 'x'.repeat(MCP_TOOL_SEGMENT_MAX)
    const left = mcpExternalToolName('rea', `${base}AAA`)
    const right = mcpExternalToolName('rea', `${base}BBB`)
    expect(left.ok && right.ok).toBe(true)
    expect(left.name).not.toBe(right.name)
  })

  it('fits the ceiling for the longest legal alias as well as the shortest', () => {
    // The segment budget is what the alias in use leaves behind, so a 12-char alias cannot push a
    // long advertised name past `TOOL_NAME_MAX` and make the tool unregistrable.
    const alias = 'p'.repeat(MCP_ALIAS_MAX)
    const whole = mcpExternalToolName(alias, 'b'.repeat(MCP_TOOL_SEGMENT_MAX))
    expect(whole.ok).toBe(true)
    expect(whole.elided).toBe(false)
    expect(whole.name.length).toBeLessThanOrEqual(TOOL_NAME_MAX)
    // One character past the budget is elided rather than rejected, and lands exactly on the cap.
    const long = mcpExternalToolName(alias, 'b'.repeat(MCP_TOOL_SEGMENT_MAX + 1))
    expect(long.ok).toBe(true)
    expect(long.elided).toBe(true)
    expect(long.name.length).toBe(TOOL_NAME_MAX)
    // A short alias buys a correspondingly longer segment.
    const short = mcpExternalToolName('a', 'b'.repeat(MCP_TOOL_SEGMENT_MAX + 10))
    expect(short.ok).toBe(true)
    expect(short.elided).toBe(false)
    expect(short.name.length).toBeLessThanOrEqual(TOOL_NAME_MAX)
  })

  it('never returns TOO_LONG for a canonical alias and any advertised name', () => {
    const aliases = ['a', 'rea', 'x'.repeat(MCP_ALIAS_MAX)]
    for (const alias of aliases) {
      for (const length of [1, 44, 45, 46, 47, 60, 120, 256]) {
        const name = 'q'.repeat(length)
        const result = mcpExternalToolName(alias, name)
        expect(result.reason ?? 'ok').toBe('ok')
        expect(result.name.length).toBeLessThanOrEqual(TOOL_NAME_MAX)
        expect(parseMcpExternalToolName(result.name)?.alias).toBe(alias)
      }
    }
  })

  it('rejects an illegal alias rather than inventing a usable one', () => {
    expect(mcpExternalToolName('REA', 'tool').reason).toBe('INVALID_ALIAS')
    expect(mcpExternalToolName('has_underscore', 'tool').reason).toBe('INVALID_ALIAS')
    expect(mcpExternalToolName('x'.repeat(MCP_ALIAS_MAX + 1), 'tool').reason).toBe('INVALID_ALIAS')
    expect(mcpExternalToolName('rea', '   ').reason).toBe('EMPTY_TOOL_NAME')
  })

  it('treats the first double underscore as the separator because aliases never contain one', () => {
    const parsed = parseMcpExternalToolName('mcp__rea__resource__my__nested__name')
    expect(parsed).toEqual({
      alias: 'rea',
      toolSegment: 'resource__my__nested__name',
      legacy: false
    })
  })

  it('still decodes legacy server-id names recorded in older transcripts', () => {
    const legacy = 'mcp__lclx9Kj2_Qt3v8Rz1aBcD__get_tools'
    const parsed = parseMcpExternalToolName(legacy)
    expect(parsed?.legacy).toBe(true)
    expect(parsed?.alias).toBe('lclx9Kj2_Qt3v8Rz1aBcD')
    expect(parsed?.toolSegment).toBe('get_tools')
    expect(parseMcpExternalToolName('Read')).toBeNull()
  })

  it('accepts only canonical aliases', () => {
    expect(isMcpToolAlias('rea')).toBe(true)
    expect(isMcpToolAlias('rea-2')).toBe(true)
    expect(isMcpToolAlias('')).toBe(false)
    expect(isMcpToolAlias('2rea')).toBe(false)
  })

  it('sanitizes a display name into an alias or refuses it', () => {
    expect(sanitizeToolAlias('REA Agents')).toBe('rea-agents')
    expect(sanitizeToolAlias('###')).toBe('')
    // 12-char ceiling: a long label must not push the total name past 64.
    expect(sanitizeToolAlias('a'.repeat(40)).length).toBeLessThanOrEqual(MCP_ALIAS_MAX)
  })

  it('derives a backfilled alias from the id alone, never from the editable name', () => {
    // Stored records without `toolAlias` are normalized on every read, so this path must not
    // consult `name`: the panel debounces label edits, and a name-derived alias would rename
    // every live tool identity the moment the user retyped a display label.
    const first = deriveMcpToolAlias('srv-abc')
    const again = deriveMcpToolAlias('srv-abc')
    expect(first).toBe(again)
    expect(isMcpToolAlias(first)).toBe(true)
    expect(deriveMcpToolAlias('srv-abc').length).toBeLessThanOrEqual(MCP_ALIAS_MAX)
    // Creation time may use the name, and a taken name must fall back to the hash.
    expect(deriveMcpToolAlias('srv-abc', 'Rea')).toBe('rea')
    expect(deriveMcpToolAlias('srv-abc', 'Rea', new Set(['rea']))).toBe(first)
  })
})

describe('mcp exposure policy', () => {
  it('keeps absent and empty allowlists semantically opposite', () => {
    expect(resolveMcpEffectiveToolNames(undefined)).toBeNull()
    expect(resolveMcpEffectiveToolNames({})).toBeNull()
    expect(resolveMcpEffectiveToolNames({ enabledTools: [] })?.size).toBe(0)
    expect(mcpExposureSize({})).toBeNull()
    expect(mcpExposureSize({ enabledTools: ['a'] })).toBe(1)
  })

  it('unions the allowlist with the active preset only', () => {
    const policy = {
      enabledTools: ['a', 'b'],
      toolPresets: { js: ['b', 'c'], native: ['d'] },
      activePreset: 'js'
    }
    expect([...(resolveMcpEffectiveToolNames(policy) ?? [])].sort()).toEqual(['a', 'b', 'c'])
    expect(mcpExposureSize(policy)).toBe(3)
  })

  it('validates the combined size so two half-full lists cannot exceed the cap', () => {
    const enabledTools = Array.from({ length: 20 }, (_, index) => `e${index}`)
    const preset = Array.from({ length: 20 }, (_, index) => `p${index}`)
    const check = validateMcpExposure({
      enabledTools,
      toolPresets: { wide: preset },
      activePreset: 'wide'
    })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.size).toBe(40)
    expect(mcpExposureSize(undefined)).toBeNull()
    expect(validateMcpExposure({ enabledTools: preset }).ok).toBe(true)
    expect(MCP_EXPOSED_TOOLS_MAX_PER_SERVER).toBe(32)
  })

  it('reports allowlisted names the server does not advertise', () => {
    const unknown = findUnknownEnabledToolNames({ enabledTools: ['real', 'ghost'] }, ['real'])
    expect(unknown).toEqual(['ghost'])
    // Unfiltered policies cannot be wrong.
    expect(findUnknownEnabledToolNames(undefined, ['real'])).toEqual([])
  })
})

describe('buildExposedMcpTools', () => {
  const tools = [
    { name: 'alpha' },
    { name: 'beta' },
    { name: 'build_reconstruction_obligation_ledger' },
    { name: '   ' }
  ]

  it('assigns every exposable tool a name and marks the rest with a reason', () => {
    const built = buildExposedMcpTools('rea', tools)
    expect(built.names.has('mcp__rea__alpha')).toBe(true)
    expect(built.names.has('mcp__rea__beta')).toBe(true)
    const invalid = built.exposed.find((entry) => entry.name === '   ')
    expect(invalid?.reason).toBe('EMPTY_TOOL_NAME')
    expect(built.unexposable).toBe(1)
  })

  it('marks filtered entries without removing them', () => {
    const built = buildExposedMcpTools('rea', tools, { enabledTools: ['alpha'] })
    expect(built.exposed.filter((entry) => entry.externalName).map((entry) => entry.name)).toEqual([
      'alpha'
    ])
    expect(built.exposed.find((entry) => entry.name === 'beta')?.filtered).toBe(true)
  })

  it('ships a schema only with a tool the model can actually call', () => {
    const built = buildExposedMcpTools(
      'rea',
      [
        { name: 'alpha', inputSchema: { type: 'object' } },
        { name: 'beta', inputSchema: { type: 'object' } }
      ],
      { enabledTools: ['alpha'] }
    )
    // A 229-tool server would otherwise ship 229 schemas on every capability refresh.
    expect(built.exposed.find((entry) => entry.name === 'alpha')?.inputSchema).toEqual({
      type: 'object'
    })
    expect(built.exposed.find((entry) => entry.name === 'beta')?.inputSchema).toBeUndefined()
    const unnameable = buildExposedMcpTools('rea', [{ name: '   ', inputSchema: {} }])
    expect(unnameable.exposed[0].inputSchema).toBeUndefined()
  })

  it('refuses to register two tools onto the same external name', () => {
    const collided = buildExposedMcpTools('rea', [{ name: 'a.b' }, { name: 'a_b' }])
    // The sanitizer maps `.` to `_`, so both want `mcp__rea__a_b`; one must be reported.
    expect(collided.unexposable).toBe(1)
    expect(collided.names.size).toBe(1)
    const loser = collided.exposed.filter((entry) => entry.reason === 'TOO_LONG')
    expect(loser).toHaveLength(1)
  })
})
