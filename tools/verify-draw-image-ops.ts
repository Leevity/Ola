import assert from 'node:assert/strict'
import fs from 'node:fs'
const schema = fs.readFileSync('src/shared/draw-graph.ts', 'utf8')
const canvas = fs.readFileSync('src/renderer/src/components/draw/DrawGraphCanvas.tsx', 'utf8')
const settings = fs.readFileSync('src/renderer/src/stores/settings-store.ts', 'utf8')
for (const operation of ['crop', 'mask', 'expand', 'upscale']) {
  assert.match(schema, new RegExp(`'${operation}'`))
  assert.match(canvas, new RegExp(`applyImageOperation\\('${operation}'\\)`))
}
assert.match(schema, /export type DrawGraphOperationState/)
assert.match(schema, /state\?: DrawGraphOperationState/)
assert.match(settings, /advancedDrawEnabled: false/)
assert.match(canvas, /advancedDrawEnabled && nodeMap/)
assert.match(canvas, /optionalCapabilityDisabled/)
console.log('Draw image operations verification passed')
