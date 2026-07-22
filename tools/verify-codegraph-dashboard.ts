import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dashboard = readFileSync(
  'src/renderer/src/components/settings/CodeGraphDashboard.tsx',
  'utf8'
)
const panel = readFileSync('src/renderer/src/components/settings/AppPluginPanel.tsx', 'utf8')
const routing = readFileSync('src/renderer/src/lib/ipc/messagepack-channel-routing.ts', 'utf8')
const handlers = readFileSync('src/main/ipc/codegraph-handlers.ts', 'utf8')

for (const method of [
  'codegraph/index-status',
  'codegraph/stats',
  '10_000',
  'codegraph/search',
  'codegraph/callers',
  'codegraph/callees',
  'codegraph/query-neighbors'
]) {
  assert.match(dashboard, new RegExp(method.replace('/', '\\/')))
}
assert.match(dashboard, /CODEGRAPH_INDEX_PROGRESS/)
assert.match(dashboard, /workingFolder: projectPath/)
assert.match(dashboard, /openFilePreview/)
assert.match(panel, /selectedPlugin\.id === CODEGRAPH_PLUGIN_ID && selectedPlugin\.enabled/)
assert.match(routing, /'codegraph:status'/)
assert.match(handlers, /RECOVERABLE_DASHBOARD_METHODS/)
assert.match(handlers, /recycling stalled dashboard request/)
assert.doesNotMatch(dashboard, /new Worker|WebSocket|canvas|getContext\(/)

console.log('CodeGraph dashboard verification passed')
