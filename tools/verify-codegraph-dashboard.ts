import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// Every assertion here is about tokens, not layout, so the sources are read collapsed.
// Collapsing turns a wrapped expression into `a .b` / `key: value`, so patterns tolerate a
// space wherever the formatter may break a line.
const dashboard = await readCollapsedSource(
  'src/renderer/src/components/settings/CodeGraphDashboard.tsx'
)
const panel = await readCollapsedSource('src/renderer/src/components/settings/AppPluginPanel.tsx')
const routing = await readCollapsedSource('src/renderer/src/lib/ipc/messagepack-channel-routing.ts')
const handlers = await readCollapsedSource('src/main/ipc/codegraph-handlers.ts')
const sync = await readCollapsedSource('src/main/lib/codegraph-sync.ts')
const main = await readCollapsedSource('src/main/index.ts')

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
assert.match(dashboard, /workingFolder:\s*projectPath/)
assert.match(dashboard, /openFilePreview/)
assert.match(
  panel,
  /selectedPlugin\s*\.\s*id\s*===\s*CODEGRAPH_PLUGIN_ID\s*&&\s*selectedPlugin\s*\.\s*enabled/
)
assert.match(routing, /'codegraph:status'/)
assert.match(handlers, /workerReady:\s*true/)
assert.doesNotMatch(handlers, /getCodeGraphWorker|resolveCodeGraphWorkerPath|OLA_CODEGRAPH_RUNTIME/)
assert.match(handlers, /observeCodeGraphOperation/)
assert.match(handlers, /startCodeGraphSync/)
assert.match(handlers, /runtime:\s*'ts-wasm'/)
assert.match(dashboard, /grammarStatus/)
assert.match(sync, /AUTO_SYNC_DEBOUNCE_MS/)
assert.match(sync, /MAX_AUTO_SYNC_PROJECTS/)
assert.match(sync, /MAX_AUTO_SYNC_DIRECTORIES/)
assert.match(sync, /collectWatchableDirectories/)
assert.match(sync, /entry\s*\.\s*syncing/)
assert.match(sync, /isIndexedProject/)
assert.match(sync, /errorKind\s*!==\s*'not_indexed'/)
assert.match(sync, /codegraph\/list-projects/)
assert.match(sync, /codegraph\/sync/)
assert.match(sync, /OLA_CODEGRAPH_AUTO_SYNC\s*!==\s*'0'/)
assert.match(main, /stopCodeGraphSync\(\s*\)/)
assert.doesNotMatch(dashboard, /new Worker|WebSocket|canvas|getContext\(/)

console.log('CodeGraph dashboard verification passed')
