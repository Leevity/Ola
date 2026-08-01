import assert from 'node:assert/strict'
import fs from 'node:fs'

const schema = fs.readFileSync('src/shared/draw-graph.ts', 'utf8')
const persistence = fs.readFileSync('src/main/ipc/draw-graph-handlers.ts', 'utf8')
const canvas = fs.readFileSync('src/renderer/src/components/draw/DrawGraphCanvas.tsx', 'utf8')
const promptLibrary = fs.readFileSync(
  'src/renderer/src/components/draw/graph/prompt-library.ts',
  'utf8'
)
assert.match(schema, /DRAW_GRAPH_SCHEMA_VERSION = 1/)
assert.match(persistence, /crypto\.randomUUID\(\).*\.tmp/)
assert.match(persistence, /fs\.rename\(temporary, files\.target\)/)
assert.match(persistence, /saveQueues/)
assert.match(persistence, /files\.backup/)
for (const feature of ['Undo2', 'Redo2', 'minimap', "addNode('image')", 'project.edges'])
  assert.match(canvas, new RegExp(feature.replace(/[()'.]/g, '\\$&')))
assert.match(canvas, /PromptLibraryDialog/)
assert.match(canvas, /onUsePrompt={usePrompt}/)
for (const category of ['product', 'portrait', 'scene', 'editing']) {
  assert.match(promptLibrary, new RegExp(`category: '${category}'`))
}
console.log('Draw Graph core verification passed')
