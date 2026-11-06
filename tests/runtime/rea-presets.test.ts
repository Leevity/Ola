import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MCP_EXPOSED_TOOLS_MAX_PER_SERVER,
  MCP_TOOL_SEGMENT_MAX,
  isMcpToolAlias,
  mcpExternalToolName,
  validateMcpExposure
} from '../../src/shared/mcp-tool-policy'
import {
  REA_MCP_ALIAS,
  REA_MCP_CONFIG_DEFAULTS,
  REA_MCP_NODE_RANGE,
  REA_MCP_PRESETS,
  REA_MCP_PRESET_NAMES,
  REA_MCP_RECIPE_BUDGET,
  REA_MCP_SPINE_TOOLS,
  REA_MCP_TIMEOUTS
} from '../../src/shared/rea-mcp-recipe'
import { matchesNodeRange } from '../../src/shared/semver-range-lite'
import { normalizeStoredServer } from '../../src/main/mcp/mcp-config-store'

type CatalogTool = { name: string; category: string; engines: string[]; readOnly: boolean }

const fixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/rea-tools.json'), 'utf8')) as {
  count: number
  tools: CatalogTool[]
  server: { enginesNode: string }
}

const byName = new Map(fixture.tools.map((tool) => [tool.name, tool]))

describe('REA preset recipe', () => {
  it('names only tools the pinned inventory actually advertises', () => {
    const invented = [
      ...REA_MCP_SPINE_TOOLS,
      ...REA_MCP_PRESET_NAMES.flatMap((n) => REA_MCP_PRESETS[n].tools)
    ].filter((name) => !byName.has(name))
    expect([...new Set(invented)]).toEqual([])
  })

  it('keeps the spine engine-free so it works on a bare host', () => {
    for (const name of REA_MCP_SPINE_TOOLS) {
      expect(byName.get(name)?.engines).toEqual([])
    }
  })

  it('draws mostly from its own category and never repeats a tool across presets', () => {
    // Presets may borrow: the JavaScript preset legitimately needs archive carving, which the
    // inventory files under `native`. What must not happen is a preset that is mostly something
    // else, or two presets claiming one tool so switching presets changes the meaning of a name.
    const seen = new Map<string, string>()
    for (const presetName of REA_MCP_PRESET_NAMES) {
      const preset = REA_MCP_PRESETS[presetName]
      expect(preset.tools.length).toBeGreaterThan(0)
      let own = 0
      for (const toolName of preset.tools) {
        if (byName.get(toolName)?.category === presetName) own += 1
        const previous = seen.get(toolName)
        expect(previous, `${toolName} claimed by ${previous} and ${presetName}`).toBeUndefined()
        seen.set(toolName, presetName)
      }
      expect(
        own * 2,
        `${presetName}: only ${own}/${preset.tools.length} own-category`
      ).toBeGreaterThanOrEqual(preset.tools.length)
    }
  })

  it('keeps all four target categories reachable', () => {
    // The user asked for JS/Electron, native, Android and web all to work; a preset that quietly
    // disappears makes the integration half-done.
    expect(REA_MCP_PRESET_NAMES.sort()).toEqual(['android', 'javascript', 'native', 'web'])
    for (const name of REA_MCP_PRESET_NAMES) expect(REA_MCP_PRESETS[name].summary).toBeTruthy()
  })

  it('fits the per-server ceiling with the spine plus the widest preset', () => {
    expect(REA_MCP_RECIPE_BUDGET.spine + REA_MCP_RECIPE_BUDGET.widestPreset).toBeLessThanOrEqual(
      REA_MCP_RECIPE_BUDGET.perServerCap
    )
    for (const name of REA_MCP_PRESET_NAMES) {
      const combined = new Set([...REA_MCP_SPINE_TOOLS, ...REA_MCP_PRESETS[name].tools])
      expect(combined.size).toBeLessThanOrEqual(MCP_EXPOSED_TOOLS_MAX_PER_SERVER)
      const check = validateMcpExposure({
        enabledTools: [...REA_MCP_SPINE_TOOLS],
        toolPresets: REA_MCP_CONFIG_DEFAULTS.toolPresets,
        activePreset: name
      })
      expect(check.ok, `preset ${name} rejected`).toBe(true)
    }
  })

  it('produces a legal external name for every tool it exposes', () => {
    for (const name of [
      ...REA_MCP_SPINE_TOOLS,
      ...REA_MCP_PRESET_NAMES.flatMap((n) => REA_MCP_PRESETS[n].tools)
    ]) {
      expect(name.length).toBeLessThanOrEqual(MCP_TOOL_SEGMENT_MAX)
      const result = mcpExternalToolName(REA_MCP_ALIAS, name)
      expect(result.ok).toBe(true)
      expect(result.elided).toBe(false)
    }
  })

  it('declares an alias that survives the naming grammar', () => {
    expect(isMcpToolAlias(REA_MCP_ALIAS)).toBe(true)
  })

  it('stores cleanly, so the recipe is not just documentation', () => {
    const stored = normalizeStoredServer({
      id: 'rea-server',
      createdAt: 1,
      toolAlias: REA_MCP_ALIAS,
      ...REA_MCP_CONFIG_DEFAULTS,
      name: REA_MCP_CONFIG_DEFAULTS.name,
      enabled: true,
      transport: REA_MCP_CONFIG_DEFAULTS.transport,
      command: 'node',
      args: ['-y', 'rea-agents@6.8.0', 'mcp']
    })
    expect(stored?.toolAlias).toBe(REA_MCP_ALIAS)
    expect(stored?.enabledTools).toEqual([...REA_MCP_SPINE_TOOLS])
    expect(stored?.activePreset).toBe('javascript')
    expect(stored?.timeoutMs).toBe(REA_MCP_TIMEOUTS.core)
    // A typo in either module would silently drop the cap on the round trip.
    expect(stored?.outputLimits).toEqual(REA_MCP_CONFIG_DEFAULTS.outputLimits)
    expect(stored?.preflight).toEqual(REA_MCP_CONFIG_DEFAULTS.preflight)
  })

  it('states the Node requirement as a range the matcher can read', () => {
    expect(matchesNodeRange('v24.22.1', REA_MCP_NODE_RANGE)).toBe('satisfied')
    expect(matchesNodeRange('v25.6.1', REA_MCP_NODE_RANGE)).toBe('unsatisfied')
    expect(fixture.server.enginesNode).toBe(REA_MCP_NODE_RANGE)
  })

  it('asks REA to stay below the inline frame it will be checked against', () => {
    const declared = Number(REA_MCP_CONFIG_DEFAULTS.env.REA_MCP_MAX_RESPONSE_BYTES)
    const inline = REA_MCP_CONFIG_DEFAULTS.outputLimits.inlineTextBytes
    expect(declared).toBeLessThanOrEqual(inline)
    expect(REA_MCP_CONFIG_DEFAULTS.env.REA_MCP_INPUT_SCHEMA_PROFILE).toBe('compact')
  })

  it('pins the inventory the presets were drawn from', () => {
    expect(fixture.count).toBe(fixture.tools.length)
    expect(fixture.tools.length).toBe(229)
  })
})
