import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dashboard = readFileSync(
  'src/renderer/src/components/settings/CodeGraphDashboard.tsx',
  'utf8'
)
const panel = readFileSync('src/renderer/src/components/settings/AppPluginPanel.tsx', 'utf8')
const routing = readFileSync('src/renderer/src/lib/ipc/messagepack-channel-routing.ts', 'utf8')

for (const method of [
  'codegraph/index-status',
  'codegraph/stats',
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
assert.doesNotMatch(dashboard, /new Worker|WebSocket|canvas|getContext\(/)

console.log('CodeGraph dashboard verification passed')
