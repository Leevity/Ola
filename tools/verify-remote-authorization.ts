import assert from 'node:assert/strict'
import {
  isInputSessionAuthorized,
  isRemoteControlAllowed,
  setAuthorizedInputSession,
  setRemoteControlAllowed,
  subscribeRemoteControlRevoked
} from '../src/main/remote/authorization-state.ts'

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

console.log('remote authorization verifier passed')
