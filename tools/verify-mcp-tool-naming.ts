// Gate: one MCP tool name, derived the same way in every layer.
//
// The bug this prevents is the silent one: Main registered a tool under a name it allocated in
// memory while the renderer rebuilt a name from the server id, so the two disagreed and the tool
// simply disappeared from the model's view. Every check below is about that single invariant —
// that the name is a pure function of (immutable alias, advertised tool name) and that no second
// implementation of it exists anywhere in the tree.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  MCP_EXPOSED_TOOLS_MAX_PER_SERVER,
  MCP_RUN_TOOL_BUDGET,
  MCP_TOOL_SEGMENT_MAX,
  buildExposedMcpTools,
  deriveMcpToolAlias,
  isMcpToolAlias,
  mcpExternalToolName,
  mcpExposureSize,
  parseMcpExternalToolName,
  resolveMcpEffectiveToolNames,
  validateMcpExposure
} from '../src/shared/mcp-tool-policy.ts'
import {
  REA_MCP_ALIAS,
  REA_MCP_CONFIG_DEFAULTS,
  REA_MCP_PRESETS,
  REA_MCP_SPINE_TOOLS
} from '../src/shared/rea-mcp-recipe.ts'
import { TOOL_NAME_MAX } from '../src/shared/tool-naming.ts'
import { parseRunSpec } from '../src/shared/runtime/contracts.ts'

const root = process.cwd()
const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/rea-tools.json'), 'utf8')) as {
  count: number
  overSegmentBudget: string[]
  tools: { name: string; category?: string }[]
}
assert.equal(fixture.tools.length, fixture.count, 'fixture count drifted from its tool list')

const advertised = fixture.tools.map((tool) => ({ name: tool.name }))

// --- The alias is legal and never derived from an editable label. ---
assert.ok(isMcpToolAlias(REA_MCP_ALIAS), `recipe alias "${REA_MCP_ALIAS}" is not canonical`)
assert.equal(deriveMcpToolAlias('rea-agents-server-id', REA_MCP_ALIAS), REA_MCP_ALIAS)

// --- Every advertised name produces a provider-legal external name. ---
const providerCharset = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const built = buildExposedMcpTools(REA_MCP_ALIAS, advertised)
const names = new Set<string>()
let elided = 0
for (const tool of built.exposed) {
  assert.ok(tool.externalName, `tool "${tool.name}" was exposed without a name`)
  assert.equal(tool.reason, undefined, `tool "${tool.name}" reports ${tool.reason}`)
  assert.ok(tool.externalName.length <= TOOL_NAME_MAX, `${tool.externalName} exceeds 64 chars`)
  assert.ok(providerCharset.test(tool.externalName), `${tool.externalName} is not provider-legal`)
  assert.equal(
    tool.externalName,
    mcpExternalToolName(REA_MCP_ALIAS, tool.name).name,
    'the registry name and the shipped name disagree'
  )
  const parsed = parseMcpExternalToolName(tool.externalName)
  assert.equal(parsed?.alias, REA_MCP_ALIAS, `${tool.externalName} does not decode to its alias`)
  assert.equal(parsed?.legacy, false, `${tool.externalName} decoded as a legacy name`)
  assert.equal(names.has(tool.externalName), false, `${tool.externalName} is not unique`)
  names.add(tool.externalName)
  if (tool.elided) elided += 1
}
assert.equal(built.exposed.length, advertised.length, 'a tool was dropped, not named')
assert.equal(built.unexposable, 0, 'the recipe alias cannot name the server it is for')
assert.ok(
  elided === fixture.overSegmentBudget.length,
  `elided count ${elided} does not match the fixture list ${fixture.overSegmentBudget.length}`
)
// The resource convention has to survive the same decoder.
const resource = mcpExternalToolName(REA_MCP_ALIAS, 'resource__report')
assert.ok(resource.ok)
assert.equal(parseMcpExternalToolName(resource.name)?.toolSegment, 'resource__report')

// --- An illegal alias names nothing, and says so instead of inventing a name. ---
for (const alias of ['', 'Rea', 'rea_agents', 'a'.repeat(13)]) {
  const result = mcpExternalToolName(alias, 'analyze')
  assert.equal(result.ok, false, `"${alias}" was accepted as an alias`)
  assert.equal(result.reason, 'INVALID_ALIAS')
}

// --- The recipe stays inside both budgets. ---
const presetNames = Object.keys(REA_MCP_PRESETS)
assert.ok(presetNames.length > 0, 'the recipe has no presets')
const known = new Set(advertised.map((tool) => tool.name))
for (const name of REA_MCP_SPINE_TOOLS)
  assert.ok(known.has(name), `spine tool "${name}" is unknown`)
// Presets must be validated in the shape Main persists — `Record<string, string[]>`. Handing the
// policy the richer `ReaMcpPreset` objects would make `resolveMcpEffectiveToolNames` ignore them,
// so the ceiling check below would prove nothing about a real REA config.
const storedPresets = REA_MCP_CONFIG_DEFAULTS.toolPresets ?? {}
assert.equal(
  Object.keys(storedPresets).length,
  presetNames.length,
  'the recipe defaults carry a different preset set than REA_MCP_PRESETS'
)
for (const preset of presetNames) {
  const policy = {
    enabledTools: [...REA_MCP_SPINE_TOOLS],
    toolPresets: storedPresets,
    activePreset: preset
  }
  const check = validateMcpExposure(policy)
  assert.ok(check.ok, `preset "${preset}" is over the per-server ceiling: ${check.error}`)
  assert.ok(
    (mcpExposureSize(policy) ?? 0) <= MCP_RUN_TOOL_BUDGET,
    `preset "${preset}" cannot fit one run`
  )
  const effective = resolveMcpEffectiveToolNames(policy)
  assert.ok(
    effective?.has(REA_MCP_SPINE_TOOLS[0] ?? ''),
    `preset "${preset}" stopped exposing the spine`
  )
  for (const tool of REA_MCP_PRESETS[preset].tools) {
    assert.ok(known.has(tool), `preset "${preset}" lists unknown tool "${tool}"`)
    assert.ok(effective?.has(tool), `preset "${preset}" never reaches tool "${tool}"`)
  }
}
assert.ok(
  REA_MCP_CONFIG_DEFAULTS.outputLimits.inlineTextBytes <=
    REA_MCP_CONFIG_DEFAULTS.outputLimits.maxResultBytes,
  'the recipe would spill nothing and fail every oversized result'
)

// --- The 128-name run budget is the load-bearing limit, not a suggestion. ---
const runSpec = (toolNames: string[]) => ({
  runId: 'run-1',
  taskId: 'task-1',
  requestId: 'request-1',
  traceId: 'trace-1',
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  environmentId: 'local',
  workingDirectory: '/tmp/ola-naming-verify',
  prompt: 'verify',
  unattended: false,
  modelSource: { kind: 'local', providerId: 'anthropic', modelId: 'claude-verify' },
  toolNames
})
assert.doesNotThrow(() => parseRunSpec(runSpec([...names].slice(0, MCP_RUN_TOOL_BUDGET))))
assert.throws(() => parseRunSpec(runSpec([...names].slice(0, MCP_RUN_TOOL_BUDGET + 1))))
assert.throws(() => parseRunSpec(runSpec(['a'.repeat(TOOL_NAME_MAX + 1)])))

// --- No second implementation of the name exists. ---
const policyPath = join(root, 'src/shared/mcp-tool-policy.ts')
const offenders: string[] = []
const walk = (directory: string): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && path !== policyPath) {
      const source = readFileSync(path, 'utf8')
      // Anything that composes an MCP name from a server id can drift from Main's allocation.
      if (
        /mcp__\$\{[^}]*(serverId|server\.id)/.test(source) ||
        /\$\{[A-Za-z_.]*[sS]erverId\}?\}__/.test(source)
      )
        offenders.push(relative(root, path))
    }
  }
}
for (const top of ['src/main', 'src/renderer', 'src/runtime', 'src/shared']) walk(join(root, top))
assert.deepEqual(offenders, [], 'MCP tool names are built outside the shared policy')

console.log(
  `mcp tool naming verification passed (${advertised.length} tools, ${elided} elided, ` +
    `${presetNames.length} presets, ceiling ${MCP_EXPOSED_TOOLS_MAX_PER_SERVER}/server, ` +
    `segment ${MCP_TOOL_SEGMENT_MAX}, run budget ${MCP_RUN_TOOL_BUDGET})`
)
