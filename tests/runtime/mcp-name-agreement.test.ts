// Core regression for the MCP naming mismatch.
//
// The renderer builds `run.toolNames`; Main's `selectExplicitTools` matches those strings exactly.
// While Main assigned names through a stateful `ToolNamer` that truncated at 64 characters and the
// renderer concatenated `mcp__<21-char server id>__<tool>` raw, the longest REA names stopped
// matching and the tools vanished from the run with no error anywhere. Both sides now derive the
// name from `toolAlias` plus the advertised name, so this test pins the agreement.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MCP_EXPOSED_TOOLS_MAX_PER_SERVER,
  MCP_RUN_TOOL_BUDGET,
  mcpExternalToolName
} from '../../src/shared/mcp-tool-policy'
import { TOOL_NAME_MAX, ToolNamer } from '../../src/shared/tool-naming'
import { parseRunSpec } from '../../src/shared/runtime/contracts'
import {
  REA_MCP_ALIAS,
  REA_MCP_CONFIG_DEFAULTS,
  REA_MCP_PRESETS
} from '../../src/shared/rea-mcp-recipe'
import { createMcpRuntimeTools, type McpRuntimeManager } from '../../src/main/mcp/mcp-runtime-tools'
import type { ExposedMcpTool } from '../../src/main/mcp/mcp-types'

type CatalogTool = { name: string; description?: string; category?: string }

const fixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/rea-tools.json'), 'utf8')) as {
  count: number
  tools: CatalogTool[]
}
const advertised = fixture.tools.map((tool) => tool.name)

const runSpecBase = {
  runId: 'run',
  taskId: 'task',
  requestId: 'request',
  traceId: 'trace',
  sessionId: 'session',
  workspaceId: 'local-personal',
  environmentId: 'local',
  modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
  prompt: 'hello',
  unattended: false
}

function managerFor(tools: ExposedMcpTool[]): McpRuntimeManager {
  return {
    getTools: () => tools,
    getToolAlias: () => REA_MCP_ALIAS,
    callTool: async () => ({ content: [] })
  }
}

function exposedFor(names: readonly string[]): ExposedMcpTool[] {
  return names.map((name) => ({
    name,
    alias: REA_MCP_ALIAS,
    externalName: mcpExternalToolName(REA_MCP_ALIAS, name).name
  }))
}

describe('mcp tool name agreement', () => {
  it('registers every advertised REA tool under a name the renderer can reproduce', () => {
    const exposed = exposedFor(advertised)
    const registered = createMcpRuntimeTools(managerFor(exposed), ['rea-server'])
    const byName = new Map(exposed.map((tool) => [tool.name, tool.externalName]))

    // One definition per advertised tool: nothing dropped, nothing renamed.
    expect(registered).toHaveLength(advertised.length)
    for (const definition of registered) {
      const advertisedName = definition.name.slice(`mcp__${REA_MCP_ALIAS}__`.length)
      expect(definition.name).toBe(byName.get(advertisedName))
    }
  })

  it('keeps every external name inside the provider ceiling and the run-spec grammar', () => {
    const names = advertised.map((name) => mcpExternalToolName(REA_MCP_ALIAS, name))
    for (const entry of names) {
      expect(entry.ok).toBe(true)
      expect(entry.name.length).toBeLessThanOrEqual(TOOL_NAME_MAX)
    }
    const unique = new Set(names.map((entry) => entry.name))
    expect(unique.size).toBe(advertised.length)
    expect(() => parseRunSpec({ ...runSpecBase, toolNames: [...unique] })).toThrow('INVALID_RUN')
    // The throw above is the 128 budget, not the grammar: 229 names cannot be sent at once.
    expect(() =>
      parseRunSpec({ ...runSpecBase, toolNames: [...unique].slice(0, 120) })
    ).not.toThrow()
  })

  it('reproduces the pre-fix divergence so the fix cannot quietly regress', () => {
    const legacyServerId = 'lclx9Kj2_Qt3v8Rz1aBcD'
    const longest = 'build_reconstruction_obligation_ledger'
    const rendererName = `mcp__${legacyServerId}__${longest}`
    expect(rendererName.length).toBeGreaterThan(TOOL_NAME_MAX)

    const namer = new ToolNamer()
    const mainName = namer.nameFor(`mcp:${legacyServerId}:${longest}`, rendererName)
    expect(mainName).not.toBe(rendererName)
    expect(mainName.length).toBeLessThanOrEqual(TOOL_NAME_MAX)

    // The alias-based scheme is the one both sides can recompute.
    expect(mcpExternalToolName(REA_MCP_ALIAS, longest).name).toBe(
      `mcp__${REA_MCP_ALIAS}__${longest}`
    )
  })

  it('stays within the run budget once the recipe policy is applied', () => {
    const preset = REA_MCP_PRESETS[REA_MCP_CONFIG_DEFAULTS.activePreset ?? 'javascript']
    const enabled = [...REA_MCP_CONFIG_DEFAULTS.enabledTools, ...preset.tools]
    const unique = [...new Set(enabled)].filter((name) => advertised.includes(name))
    expect(unique.length).toBeLessThanOrEqual(MCP_EXPOSED_TOOLS_MAX_PER_SERVER)

    const names = unique.map((name) => mcpExternalToolName(REA_MCP_ALIAS, name).name)
    expect(() => parseRunSpec({ ...runSpecBase, toolNames: names })).not.toThrow()
    expect(names.length + 48).toBeLessThan(MCP_RUN_TOOL_BUDGET)
  })

  it('reports a tool whose external name cannot be formed instead of dropping it', () => {
    const broken = [...exposedFor(['good_tool']), { name: '   ', alias: REA_MCP_ALIAS }]
    const registered = createMcpRuntimeTools(managerFor(broken), ['rea-server'])
    expect(registered.map((definition) => definition.name)).toEqual(['mcp__rea__good_tool'])
  })

  it('survives a server whose id is long, because ids never reach the name', () => {
    const longId = 'server-'.padEnd(80, 'x')
    const exposed = exposedFor(['binary_session'])
    const registered = createMcpRuntimeTools(managerFor(exposed), [longId])
    expect(registered[0]?.name).toBe(`mcp__${REA_MCP_ALIAS}__binary_session`)
    expect(registered[0]?.name.length).toBeLessThanOrEqual(TOOL_NAME_MAX)
  })
})
