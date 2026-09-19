import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  isInputSessionAuthorized,
  isRemoteControlAllowed,
  setAuthorizedInputSession,
  setRemoteControlAllowed,
  subscribeRemoteControlRevoked
} from '../src/main/remote/authorization-state.ts'
import { RemoteSessionManager } from '../src/main/remote/session-manager.ts'

let revokeCount = 0
const unsubscribe = subscribeRemoteControlRevoked(() => {
  revokeCount += 1
})

setRemoteControlAllowed(false)
assert.equal(revokeCount, 1)
assert.equal(isRemoteControlAllowed(), false)
assert.throws(
  () => setAuthorizedInputSession('session-before-allow'),
  /Remote control is not allowed/
)

setRemoteControlAllowed(true)
setAuthorizedInputSession('session-a')
assert.equal(isInputSessionAuthorized('session-a'), true)
assert.equal(isInputSessionAuthorized('session-b'), false)

setRemoteControlAllowed(false)
assert.equal(revokeCount, 2)
assert.equal(isInputSessionAuthorized('session-a'), false)

setRemoteControlAllowed(true)
assert.equal(isInputSessionAuthorized('session-a'), false)
setAuthorizedInputSession('session-b')
assert.equal(isInputSessionAuthorized('session-b'), true)
setAuthorizedInputSession(null)
assert.equal(isInputSessionAuthorized('session-b'), false)
unsubscribe()

const inputController = readFileSync('src/main/remote/input-controller.ts', 'utf8')
const engine = readFileSync('src/main/remote/engine.ts', 'utf8')
const remoteAccountStore = readFileSync('src/renderer/src/stores/remote-account-store.ts', 'utf8')
const remoteAccountClient = readFileSync('src/main/remote/account-client.ts', 'utf8')
assert.match(inputController, /export function clearRemoteInputSessionIfOwned\(/)
assert.match(
  inputController,
  /enabledOwnerWebContentsId !== ownerWebContentsId[\s\S]*!isInputSessionAuthorized\(sessionId\)/
)
assert.match(
  engine,
  /disconnect\(sessionId: string, ownerWebContentsId: number\)[\s\S]*clearRemoteInputSessionIfOwned\(sessionId, ownerWebContentsId\)/
)
assert.match(remoteAccountStore, /DEFAULT_API_BASE_URL = 'https:\/\/lbxai\.cn'/)
assert.match(remoteAccountStore, /LEGACY_DEFAULT_API_BASE_URL = 'http:\/\/100\.64\.0\.6:7300'/)
assert.match(remoteAccountStore, /normalizeApiBaseUrl\(parsed\.apiBaseUrl\)/)
assert.match(remoteAccountClient, /DEFAULT_REMOTE_ACCOUNT_API_BASE_URL = 'https:\/\/lbxai\.cn'/)
assert.match(remoteAccountClient, /migrateLegacyRemoteApiBaseUrl\(memoryState\.apiBaseUrl\)/)
assert.match(remoteAccountClient, /\/oauth\/authorize/)
assert.match(
  engine,
  /disconnectOwnedBy\(ownerWebContentsId: number\)[\s\S]*clearRemoteInputSession\(ownerWebContentsId\)/
)

const sessions = new RemoteSessionManager()
const ownerSession = sessions.create(
  {
    id: 'owner-session',
    kind: 'rdp',
    connectionId: 'connection-a',
    status: 'connected',
    viewerType: 'rdp',
    credentialAvailable: true
  },
  101
)
assert.equal(sessions.listByOwner(101).length, 1)
assert.equal(sessions.listByOwner(202).length, 0)
assert.equal(sessions.isOwnedBy(ownerSession.id, 101), true)
assert.equal(sessions.isOwnedBy(ownerSession.id, 202), false)
assert.equal('ownerWebContentsId' in sessions.listByOwner(101)[0], false)
sessions.disconnectByOwner(202)
assert.equal(sessions.listByOwner(101)[0].status, 'connected')
sessions.disconnectByOwner(101)
assert.equal(sessions.listByOwner(101)[0].status, 'disconnected')

console.log('remote authorization verifier passed')
