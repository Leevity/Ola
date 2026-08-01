import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createEmptyDrawGraphProject } from '../src/shared/draw-graph.ts'
import { resolveReadyDrawGraphTriggers } from '../src/shared/draw-graph-triggers.ts'

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

const triggerProject = createEmptyDrawGraphProject('trigger-test')
triggerProject.nodes = [
  {
    id: 'source',
    kind: 'image',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    title: 'Source',
    content: '',
    status: 'completed',
    outputAssetId: 'source-output'
  },
  {
    id: 'target',
    kind: 'image',
    x: 200,
    y: 0,
    width: 100,
    height: 100,
    title: 'Target',
    content: '',
    asset: {
      id: '00000000-0000-0000-0000-000000000000.png',
      mediaType: 'image/png',
      width: 100,
      height: 100
    },
    trigger: { enabled: true, action: 'upscale' }
  }
]
triggerProject.edges = [{ id: 'edge', source: 'source', target: 'target' }]
const [readyTrigger] = resolveReadyDrawGraphTriggers(triggerProject)
assert.equal(readyTrigger?.nodeId, 'target')
assert.equal(readyTrigger?.action, 'upscale')
triggerProject.nodes[1].trigger!.lastRunKey = readyTrigger.runKey
assert.deepEqual(resolveReadyDrawGraphTriggers(triggerProject), [])
triggerProject.nodes[0].outputAssetId = 'new-source-output'
assert.equal(resolveReadyDrawGraphTriggers(triggerProject).length, 1)
console.log('Draw Graph core verification passed')
