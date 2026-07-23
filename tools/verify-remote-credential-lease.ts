import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ViewerCredentialLeaseRegistry } from '../src/main/remote/viewer-credential-lease.ts'

const registry = new ViewerCredentialLeaseRegistry()
const credential = { username: 'alice', password: 'secret', domain: 'CORP' }

const lease = registry.issue('session-a', 101, credential)
assert.match(lease, /^[A-Za-z0-9_-]{40,}$/)
assert.equal(registry.claim('session-a', 202, lease), null)
assert.equal(registry.claim('session-b', 101, lease), null)
assert.deepEqual(registry.claim('session-a', 101, lease), credential)
assert.equal(registry.claim('session-a', 101, lease), null)

const revokedLease = registry.issue('session-b', 101, credential)
registry.revokeSession('session-b')
assert.equal(registry.claim('session-b', 101, revokedLease), null)

const expiredLease = registry.issue('session-c', 101, credential, -1)
assert.equal(registry.claim('session-c', 101, expiredLease), null)

const sourceFiles = await Promise.all([
  readFile('src/main/ipc/remote-handlers.ts', 'utf8'),
  readFile('src/main/remote/engine.ts', 'utf8'),
  readFile('src/renderer/src/lib/ipc/channels.ts', 'utf8'),
  readFile('src/renderer/src/lib/ipc/messagepack-channel-routing.ts', 'utf8'),
  readFile('src/renderer/src/components/remote/IronRdpViewer.tsx', 'utf8'),
  readFile('src/renderer/src/components/remote/NoVncViewer.tsx', 'utf8')
])
const remoteCredentialSource = sourceFiles.join('\n')
assert.equal(remoteCredentialSource.includes('remote:session:credential'), false)
assert.equal(remoteCredentialSource.includes('getViewerCredential'), false)
assert.match(remoteCredentialSource, /remote:session:claim-credential/)

console.log('remote credential lease verifier passed')
