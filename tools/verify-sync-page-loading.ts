import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('src/renderer/src/components/sync/SyncPage.tsx', 'utf8')

// Managed workspaces skip local WebDAV v1 hydration but must still settle the
// page loading state before rendering the v2 workspace controls.
assert.match(
  source,
  /if \(workspaceId !== 'local-personal'\) \{[\s\S]{0,500}setLoading\(false\)[\s\S]{0,120}return/
)
assert.match(source, /SYNC_WORKSPACE_RUN/)
assert.match(source, /workspaceUnavailable\.v2Description/)

console.log('Sync page loading-state verification passed')
