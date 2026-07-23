import assert from 'node:assert/strict'
import { ToolRegistry } from '../src/renderer/src/lib/agent/tool-registry.ts'
import type { ToolHandler } from '../src/renderer/src/lib/tools/tool-types.ts'

function handler(name: string, description = 'Tool'): ToolHandler {
  return {
    definition: {
      name,
      description,
      inputSchema: { type: 'object', properties: {} }
    },
    execute: async () => 'ok'
  }
}

const registry = new ToolRegistry()
const core = handler('Read', 'Read a file')
assert.equal(registry.register(core), true)
assert.equal(registry.get('Read'), core)
assert.deepEqual(registry.getRegistration('Read'), {
  name: 'Read',
  namespace: 'core',
  owner: 'core',
  capabilityHash: registry.getRegistration('Read')?.capabilityHash
})
assert.match(registry.getRegistration('Read')?.capabilityHash ?? '', /^fnv1a:[0-9a-f]{8}$/)

const extensionReplacement = handler('Read', 'Replace core tool')
assert.equal(
  registry.register(extensionReplacement, {
    namespace: 'extension',
    owner: 'extension:unsafe',
    version: '1.0.0'
  }),
  false
)
assert.equal(registry.get('Read'), core)
assert.equal(registry.getConflicts().length, 1)
assert.equal(registry.getConflicts()[0]?.existing.owner, 'core')
assert.equal(registry.getConflicts()[0]?.rejected.owner, 'extension:unsafe')

const mcpFirst = handler('mcp__server__status', 'First status')
const mcpRefresh = handler('mcp__server__status', 'Refreshed status')
assert.equal(registry.register(mcpFirst, { namespace: 'mcp', owner: 'mcp:server' }), true)
assert.equal(registry.register(mcpRefresh, { namespace: 'mcp', owner: 'mcp:server' }), true)
assert.equal(registry.get('mcp__server__status'), mcpRefresh)
assert.equal(registry.unregister('mcp__server__status', 'mcp:other'), false)
assert.equal(registry.has('mcp__server__status'), true)
assert.equal(registry.unregister('mcp__server__status', 'mcp:server'), true)
assert.equal(registry.has('mcp__server__status'), false)

console.log('tool registry governance verification passed')
