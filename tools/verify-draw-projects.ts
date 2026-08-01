import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createEmptyDrawGraphProject, isValidDrawGraphProject } from '../src/shared/draw-graph'

const valid = createEmptyDrawGraphProject('project-1')
valid.nodes.push({
  id: 'node-1',
  kind: 'image',
  x: 0,
  y: 0,
  width: 200,
  height: 120,
  title: 'Image',
  content: ''
})
assert.equal(isValidDrawGraphProject(valid), true)
assert.equal(
  isValidDrawGraphProject({
    ...valid,
    changes: [
      {
        id: 'change-1',
        source: 'assistant',
        action: 'add_node',
        summary: 'Add image node',
        createdAt: Date.now()
      }
    ]
  }),
  true
)
assert.equal(
  isValidDrawGraphProject({
    ...valid,
    changes: [{ id: 'change-1', source: 'unknown', action: 'erase', summary: '', createdAt: 0 }]
  }),
  false
)
assert.equal(isValidDrawGraphProject({ ...valid, id: '../escape' }), false)
assert.equal(isValidDrawGraphProject({ ...valid, nodes: [...valid.nodes, valid.nodes[0]] }), false)
assert.equal(
  isValidDrawGraphProject({
    ...valid,
    edges: [{ id: 'edge-1', source: 'node-1', target: 'missing' }]
  }),
  false
)
assert.equal(
  isValidDrawGraphProject({
    ...valid,
    nodes: [{ ...valid.nodes[0], imageOperations: [{ id: 'op', type: 'delete-source', value: 1 }] }]
  }),
  false
)

const handlers = fs.readFileSync('src/main/ipc/draw-graph-handlers.ts', 'utf8')
assert.match(handlers, /Unauthorized draw graph IPC sender/)
assert.match(handlers, /MAX_PROJECT_BYTES/)
assert.match(handlers, /saveQueues/)
assert.match(handlers, /randomUUID/)

const canvas = fs.readFileSync('src/renderer/src/components/draw/DrawGraphCanvas.tsx', 'utf8')
for (const feature of ['createProject', 'openProject', 'promptLibrary', 'assetLibrary']) {
  assert.match(canvas, new RegExp(feature))
}
console.log('Draw projects verification passed')
