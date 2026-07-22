import assert from 'node:assert/strict'
import fs from 'node:fs'
const tool = fs.readFileSync('src/renderer/src/lib/tools/canvas-tool.ts', 'utf8')
const registry = fs.readFileSync('src/renderer/src/lib/tools/index.ts', 'utf8')
assert.match(tool, /name: 'CanvasOperation'/)
assert.match(tool, /requiresApproval: \(input\) => input.action !== 'inspect'/)
assert.match(registry, /registerCanvasTool\(\)/)
console.log('Draw canvas assistant verification passed')
