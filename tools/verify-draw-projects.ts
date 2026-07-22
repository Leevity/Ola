import assert from 'node:assert/strict'
import fs from 'node:fs'
const handlers = fs.readFileSync('src/main/ipc/draw-graph-handlers.ts', 'utf8')
const canvas = fs.readFileSync('src/renderer/src/components/draw/DrawGraphCanvas.tsx', 'utf8')
assert.match(handlers, /draw-graph:list/)
for (const feature of ['createProject', 'openProject', 'promptLibrary', 'assetLibrary']) {
  assert.match(canvas, new RegExp(feature))
}
console.log('Draw projects verification passed')
