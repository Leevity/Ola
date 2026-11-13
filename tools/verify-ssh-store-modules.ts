import assert from 'node:assert/strict'
import { SSH_STORE_EVENT_CHANNELS } from '../src/renderer/src/stores/ssh/events'
import { selectSshConnections } from '../src/renderer/src/stores/ssh/connections'
import { selectSshTransfers } from '../src/renderer/src/stores/ssh/transfers'
import type { SshConnectionsSlice } from '../src/renderer/src/stores/ssh/connections'
import type { SshExplorerSlice } from '../src/renderer/src/stores/ssh/explorer'
import type { SshSessionsSlice } from '../src/renderer/src/stores/ssh/sessions'
import type { SshSftpSlice } from '../src/renderer/src/stores/ssh/sftp'
import type { SshTransfersSlice } from '../src/renderer/src/stores/ssh/transfers'
import type { SshUiSlice } from '../src/renderer/src/stores/ssh/ui'
import { readCollapsedSource } from './lib/source-text.ts'

// Source assertions are about code, not layout: read collapsed and tolerate a space
// wherever the formatter may break a line. The negative assertion below stays just as
// strict — collapsing only lets it see a declaration that was previously wrapped.
const storeSource = await readCollapsedSource('src/renderer/src/stores/ssh-store.ts')
const hostListSource = await readCollapsedSource(
  'src/renderer/src/components/ssh/SshConnectionList.tsx'
)
const transferListSource = await readCollapsedSource(
  'src/renderer/src/components/ssh/SshSftpWorkspace.tsx'
)
assert.match(
  storeSource,
  /export\s+type\s+\*\s+from\s+['"]\.\.\/\.\.\/\.\.\/shared\/ssh-contract['"]/
)
assert.doesNotMatch(storeSource, /export\s+interface\s+SshConnection\s*\{/)
assert.match(storeSource, /extends\s+SshConnectionsSlice/)
assert.match(storeSource, /SshSessionsSlice/)
assert.match(storeSource, /SshSftpSlice/)
assert.match(storeSource, /SshTransfersSlice/)
assert.match(storeSource, /SshExplorerSlice/)
assert.match(storeSource, /SshUiSlice/)
type SixSlices = SshConnectionsSlice &
  SshSessionsSlice &
  SshSftpSlice &
  SshTransfersSlice &
  SshExplorerSlice &
  SshUiSlice
void (null as unknown as SixSlices)
assert.equal(SSH_STORE_EVENT_CHANNELS.status, 'ssh:status')

const connections = [{ id: 'connection-1' }]
const transfers = { uploadTasks: {}, transferTasks: {} }
const state = { connections, ...transfers }
assert.equal(selectSshConnections(state as never), connections)
assert.deepEqual(selectSshTransfers(state as never), transfers)
assert.match(hostListSource, /const hostVirtualizer\s*=\s*useVirtualizer/)
assert.match(hostListSource, /hostVirtualizer\s*\.\s*getVirtualItems\(\s*\)/)
assert.match(transferListSource, /const taskVirtualizer\s*=\s*useVirtualizer/)
assert.match(transferListSource, /taskVirtualizer\s*\.\s*getVirtualItems\(\s*\)/)

console.log('SSH store module verification passed')
