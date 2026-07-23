import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dashboard = readFileSync(
  'src/renderer/src/components/settings/CodeGraphDashboard.tsx',
  'utf8'
)
const panel = readFileSync('src/renderer/src/components/settings/AppPluginPanel.tsx', 'utf8')
const routing = readFileSync('src/renderer/src/lib/ipc/messagepack-channel-routing.ts', 'utf8')
const handlers = readFileSync('src/main/ipc/codegraph-handlers.ts', 'utf8')
const sync = readFileSync('src/main/lib/codegraph-sync.ts', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')

for (const method of [
  'codegraph/index-status',
  'codegraph/stats',
  '10_000',
  'codegraph/search',
  'codegraph/callers',
  'codegraph/callees',
  'codegraph/query-neighbors',
  'codegraph/list-projects',
  'codegraph/sync',
  'codegraph/remove-project',
  'codegraph/files-tree',
  'codegraph/analytics'
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
assert.match(handlers, /observeCodeGraphOperation/)
assert.match(handlers, /startCodeGraphSync/)
assert.match(handlers, /grammarStatus/)
assert.match(dashboard, /grammarStatus/)
assert.match(sync, /AUTO_SYNC_DEBOUNCE_MS/)
assert.match(sync, /MAX_AUTO_SYNC_PROJECTS/)
assert.match(sync, /MAX_AUTO_SYNC_DIRECTORIES/)
assert.match(sync, /collectWatchableDirectories/)
assert.match(sync, /entry\.syncing/)
assert.match(sync, /isIndexedProject/)
assert.match(sync, /errorKind !== 'not_indexed'/)
assert.match(sync, /codegraph\/list-projects/)
assert.match(sync, /codegraph\/sync/)
assert.match(sync, /OLA_CODEGRAPH_AUTO_SYNC !== '0'/)
assert.match(main, /stopCodeGraphSync\(\)/)
assert.doesNotMatch(dashboard, /new Worker|WebSocket|canvas|getContext\(/)

console.log('CodeGraph dashboard verification passed')
