import assert from 'node:assert/strict'
import { decodeDrawAssetDataUrl } from '../src/main/draw/draw-asset-codec'
import { readCollapsedSource } from './lib/source-text.ts'

// The source assertions are about code, not layout, so each file is read with whitespace
// collapsed. Patterns tolerate a space wherever the formatter may break a line: after
// `:` and `,`, inside brackets/parens, and around the dots of a wrapped member chain.
const schema = await readCollapsedSource('src/shared/draw-graph.ts')
const canvas = await readCollapsedSource('src/renderer/src/components/draw/DrawGraphCanvas.tsx')
const handlers = await readCollapsedSource('src/main/ipc/draw-graph-handlers.ts')
const settings = await readCollapsedSource('src/renderer/src/stores/settings-store.ts')

for (const operation of ['crop', 'mask', 'expand', 'outpaint', 'upscale', 'angle']) {
  assert.match(schema, new RegExp(`'${operation}'`))
}
for (const operation of ['cropRaster', 'buildMask', 'expandRaster', 'upscaleRaster']) {
  assert.match(canvas, new RegExp(operation))
}
assert.match(schema, /export type DrawGraphOperationState/)
assert.match(schema, /state\?:\s*DrawGraphOperationState/)
assert.match(schema, /interface DrawGraphAssetRef/)
assert.match(settings, /advancedDrawEnabled:\s*false/)
assert.match(canvas, /advancedDrawEnabled\s*&&\s*nodeMap/)
assert.match(canvas, /optionalCapabilityDisabled/)
assert.match(canvas, /draw-graph:asset-save/)
assert.match(canvas, /maskAssetId/)
assert.match(canvas, /nodes:\s*\[\s*\.\.\.current\s*\.\s*nodes,\s*outputNode\s*\]/)
assert.match(canvas, /source:\s*sourceNode\s*\.\s*id,\s*target:\s*outputNodeId/)
assert.match(canvas, /AngleGenerationDialog/)
assert.match(canvas, /generateTsOpenAIImages/)
assert.match(canvas, /Extend this image naturally into the transparent border/)
assert.match(canvas, /imageOperationControllers/)
assert.match(
  canvas,
  /setOperationState\(\s*sourceNode\s*\.\s*id,\s*operation\s*\.\s*id,\s*'cancelled'\s*\)/
)
const png = Buffer.alloc(24)
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
png.writeUInt32BE(640, 16)
png.writeUInt32BE(480, 20)
const decoded = decodeDrawAssetDataUrl(`data:image/png;base64,${png.toString('base64')}`)
assert.equal(decoded.width, 640)
assert.equal(decoded.height, 480)
assert.equal(decoded.extension, '.png')
assert.throws(() => decodeDrawAssetDataUrl('data:text/plain;base64,SGVsbG8='), /PNG or JPEG/)

assert.match(handlers, /MAX_DRAW_ASSET_BYTES/)
assert.match(handlers, /parsePngSize/)
assert.match(handlers, /parseJpegSize/)
assert.match(handlers, /ola-draw-asset/)

console.log('Draw image operations verification passed')
