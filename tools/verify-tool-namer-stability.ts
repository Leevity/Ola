import assert from 'node:assert/strict'

import {
  ToolNamer,
  fnv1a32,
  sanitizeDescription,
  sanitizeToolName,
  TOOL_NAME_MAX
} from '../src/shared/tool-naming.ts'

// --- FNV-1a deterministic ---
assert.equal(fnv1a32(''), '811c9dc5')
assert.equal(fnv1a32('a'), 'e40c292c')
assert.equal(fnv1a32('mcp__github__search'), fnv1a32('mcp__github__search'))

// --- sanitizeToolName: whitelist, collapse, length ---
assert.equal(sanitizeToolName('good_name-1'), 'good_name-1')
assert.equal(sanitizeToolName('bad name!@#'), 'bad_name')
assert.equal(sanitizeToolName('a___b'), 'a__b') // 3+ underscores collapse to __
assert.equal(sanitizeToolName('___'), 'tool') // empty after collapse → fallback
assert.equal(sanitizeToolName('x'.repeat(200)).length <= TOOL_NAME_MAX, true)
// Separator convention preserved.
assert.ok(sanitizeToolName('mcp__server__tool').includes('__'))

// --- sanitizeDescription: control chars stripped, length capped ---
assert.equal(sanitizeDescription('  hello \n world  '), 'hello world')
assert.equal(sanitizeDescription('a\u0000\u0007b'), 'ab')
assert.equal(sanitizeDescription('z'.repeat(2000)).length, 512)

// --- ToolNamer: stable per internalId, never reused, ≤64, deterministic hash on collision ---
{
  const namer = new ToolNamer()
  const first = namer.nameFor('github', 'github__search')
  assert.equal(namer.nameFor('github', 'github__search'), first) // idempotent
  assert.equal(first.length <= TOOL_NAME_MAX, true)

  // Two different internal ids must not collide even with identical desired names.
  const a = namer.nameFor('id-a', 'shared')
  const b = namer.nameFor('id-b', 'shared')
  assert.notEqual(a, b)
  assert.equal(b, `shared_${fnv1a32('id-b')}`)

  // Over-length desired names are trimmed and stay ≤64.
  const long = namer.nameFor('id-long', 'x'.repeat(200))
  assert.equal(long.length <= TOOL_NAME_MAX, true)

  // Assigned names are never reused for a different internal id.
  const names = new Set<string>()
  const probe = new ToolNamer()
  for (let i = 0; i < 500; i += 1) {
    const n = probe.nameFor('cid-' + i, 'tool-' + (i % 10))
    assert.ok(!names.has(n), `name reused: ${n}`)
    names.add(n)
  }
}

// --- reserveName for pre-activation tool cards ---
{
  const namer = new ToolNamer()
  const reserved = namer.reserveName('my tool!')
  assert.equal(reserved, 'my_tool')
  assert.equal(namer.isUsed(reserved), true)
}

console.log('tool namer stability verification passed')
