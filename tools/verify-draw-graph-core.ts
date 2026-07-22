import assert from 'node:assert/strict'
import fs from 'node:fs'

const schema = fs.readFileSync('src/shared/draw-graph.ts', 'utf8')
const persistence = fs.readFileSync('src/main/ipc/draw-graph-handlers.ts', 'utf8')
const canvas = fs.readFileSync('src/renderer/src/components/draw/DrawGraphCanvas.tsx', 'utf8')
assert.match(schema, /DRAW_GRAPH_SCHEMA_VERSION = 1/)
assert.match(persistence, /fs\.rename\(files\.temporary, files\.target\)/)
assert.match(persistence, /files\.backup/)
for (const feature of ['Undo2', 'Redo2', 'minimap', "addNode('image')", 'project.edges'])
  assert.match(canvas, new RegExp(feature.replace(/[()'.]/g, '\\$&')))
console.log('Draw Graph core verification passed')
