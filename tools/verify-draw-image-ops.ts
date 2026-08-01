import assert from 'node:assert/strict'
import fs from 'node:fs'
import { decodeDrawAssetDataUrl } from '../src/main/draw/draw-asset-codec'

const schema = fs.readFileSync('src/shared/draw-graph.ts', 'utf8')
const canvas = fs.readFileSync('src/renderer/src/components/draw/DrawGraphCanvas.tsx', 'utf8')
const handlers = fs.readFileSync('src/main/ipc/draw-graph-handlers.ts', 'utf8')
const settings = fs.readFileSync('src/renderer/src/stores/settings-store.ts', 'utf8')

for (const operation of ['crop', 'mask', 'expand', 'outpaint', 'upscale', 'angle']) {
  assert.match(schema, new RegExp(`'${operation}'`))
}
for (const operation of ['cropRaster', 'buildMask', 'expandRaster', 'upscaleRaster']) {
  assert.match(canvas, new RegExp(operation))
}
assert.match(schema, /export type DrawGraphOperationState/)
assert.match(schema, /state\?: DrawGraphOperationState/)
assert.match(schema, /interface DrawGraphAssetRef/)
assert.match(settings, /advancedDrawEnabled: false/)
assert.match(canvas, /advancedDrawEnabled && nodeMap/)
assert.match(canvas, /optionalCapabilityDisabled/)
assert.match(canvas, /draw-graph:asset-save/)
assert.match(canvas, /maskAssetId/)
assert.match(canvas, /nodes: \[\.\.\.current\.nodes, outputNode\]/)
assert.match(canvas, /source: sourceNode\.id, target: outputNodeId/)
assert.match(canvas, /AngleGenerationDialog/)
assert.match(canvas, /generateNativeOpenAIImages/)
assert.match(canvas, /Extend this image naturally into the transparent border/)
assert.match(canvas, /imageOperationControllers/)
assert.match(canvas, /setOperationState\(sourceNode\.id, operation\.id, 'cancelled'\)/)
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
