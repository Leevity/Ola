import assert from 'node:assert/strict'
import {
  currentRemoteAccessMode,
  isInputSessionAuthorized,
  isRemoteControlAllowed,
  setAuthorizedInputSession,
  setRemoteAccessMode,
  setRemoteControlAllowed,
  subscribeRemoteControlRevoked
} from '../src/main/remote/authorization-state.ts'
import { RemoteSessionManager } from '../src/main/remote/session-manager.ts'
import {
  accessSnapshot,
  admitRemoteTask,
  applyAccessMode,
  bindRunToSession,
  requestAutoApproval
} from '../src/main/remote/access-mode.ts'
import {
  decideRemoteMeshTask,
  finishRemoteMeshTask,
  listRemoteMeshTasks,
  recordVerifiedMeshTask,
  resetRemoteMeshTasks,
  setMeshTaskReceiptPublisher,
  startRemoteMeshTask,
  type MeshTaskReceiptRequest
} from '../src/main/remote/task-dispatch.ts'
import type { MeshTaskReceiptDelivery } from '../src/main/remote/mesh-events.ts'
import {
  assertIncludes,
  collapseWhitespace,
  readCollapsedSource,
  readSource
} from './lib/source-text.ts'

let revokeCount = 0
const unsubscribe = subscribeRemoteControlRevoked(() => {
  revokeCount += 1
})

// A process boots with access withdrawn. Withdrawing what is already withdrawn
// revokes nothing, and a revoke event per heartbeat echo would make every
// listener act on a control plane that never changed.
setRemoteControlAllowed(false)
assert.equal(revokeCount, 0)
assert.equal(isRemoteControlAllowed(), false)
assert.equal(currentRemoteAccessMode(), 'none')
assert.throws(
  () => setAuthorizedInputSession('session-before-allow'),
  /Remote control is not allowed/
)

setRemoteControlAllowed(true)
assert.equal(currentRemoteAccessMode(), 'attended')
setAuthorizedInputSession('session-a')
assert.equal(isInputSessionAuthorized('session-a'), true)
assert.equal(isInputSessionAuthorized('session-b'), false)

setRemoteControlAllowed(false)
assert.equal(revokeCount, 1)
assert.equal(isInputSessionAuthorized('session-a'), false)

setRemoteControlAllowed(true)
assert.equal(isInputSessionAuthorized('session-a'), false)
setAuthorizedInputSession('session-b')
assert.equal(isInputSessionAuthorized('session-b'), true)
setAuthorizedInputSession(null)
assert.equal(isInputSessionAuthorized('session-b'), false)

// Attended and unattended are equally "allowed" for input; only the durable
// mode differs, and only it is what the approval chain reads.
setRemoteAccessMode('unattended')
assert.equal(isRemoteControlAllowed(), true)
assert.equal(currentRemoteAccessMode(), 'unattended')
setAuthorizedInputSession('session-u')
assert.equal(isInputSessionAuthorized('session-u'), true)
setRemoteAccessMode('none')
assert.equal(revokeCount, 2)
assert.equal(currentRemoteAccessMode(), 'none')
assert.equal(isInputSessionAuthorized('session-u'), false)
// Revocation is idempotent: a repeated revoke must not re-notify.
setRemoteAccessMode('none')
assert.equal(revokeCount, 2)
unsubscribe()

// Source assertions are about tokens, not layout: the reads collapse whitespace and every
// pattern tolerates a break wherever the formatter may wrap one. The authorization and
// session-ownership invariants below are unchanged.
const inputControllerRaw = await readSource('src/main/remote/input-controller.ts')
const inputController = collapseWhitespace(inputControllerRaw)
const engineRaw = await readSource('src/main/remote/engine.ts')
const remoteAccountStore = await readCollapsedSource(
  'src/renderer/src/stores/remote-account-store.ts'
)
const remoteAccountClient = await readCollapsedSource('src/main/remote/account-client.ts')
// An unbounded window borrows the next function's guard: clearRemoteInputSession's owner
// check sits above ...IfOwned, and disconnect's call sits above disconnectOwnedBy. Bound
// each assertion to one declaration body. Boundaries are declaration lines, so they are
// matched on raw text; the body is still compared with whitespace collapsed.
const declarationBody = (raw: string, boundary: RegExp, name: string): string => {
  const declarations = [...raw.matchAll(boundary)].map((match) => ({
    name: match[1],
    index: match.index as number
  }))
  const owner = declarations.find((entry) => entry.name === name)
  if (!owner) throw new Error(`Missing declaration ${name}`)
  const next = declarations.find((entry) => entry.index > owner.index)
  return raw.slice(owner.index, next?.index ?? raw.length)
}
const inputFunction = (name: string): string =>
  declarationBody(inputControllerRaw, /^(?:export )?function ([A-Za-z_$][\w$]*)\s*\(/gm, name)
const engineMethod = (name: string): string =>
  declarationBody(engineRaw, /^ {2}(?:async )?([A-Za-z_$][\w$]*)\s*\(/gm, name)

assert.match(inputController, /export function clearRemoteInputSessionIfOwned\(/)
assert.match(
  inputFunction('clearRemoteInputSessionIfOwned'),
  /enabledOwnerWebContentsId !== ownerWebContentsId[\s\S]*!isInputSessionAuthorized\(\s*sessionId\s*\)/
)
// The owner-mismatch token has two sites; binding only one let the other be deleted.
assert.match(
  inputFunction('clearRemoteInputSession'),
  /enabledOwnerWebContentsId !== ownerWebContentsId/
)
const engineDisconnect = engineMethod('disconnect')
assert.match(
  engineDisconnect,
  /disconnect\(\s*sessionId: string,\s*ownerWebContentsId: number\s*\)[\s\S]*clearRemoteInputSessionIfOwned\(\s*sessionId,\s*ownerWebContentsId\s*\)/
)
// Ownership is what makes the clear safe; the call alone proved nothing about it.
assert.match(
  engineDisconnect,
  /!this\s*\.\s*sessions\s*\.\s*isOwnedBy\(\s*sessionId,\s*ownerWebContentsId\s*\)/
)
assert.match(remoteAccountStore, /DEFAULT_API_BASE_URL =\s*'https:\/\/lbxai\.cn'/)
assert.match(remoteAccountStore, /LEGACY_DEFAULT_API_BASE_URL =\s*'http:\/\/100\.64\.0\.6:7300'/)
assert.match(remoteAccountStore, /normalizeApiBaseUrl\(\s*parsed\s*\.\s*apiBaseUrl\s*\)/)
assert.match(remoteAccountClient, /DEFAULT_REMOTE_ACCOUNT_API_BASE_URL =\s*'https:\/\/lbxai\.cn'/)
assert.match(
  remoteAccountClient,
  /migrateLegacyRemoteApiBaseUrl\(\s*memoryState\s*\.\s*apiBaseUrl\s*\)/
)
assert.match(remoteAccountClient, /\/oauth\/authorize/)
const engineDisconnectOwnedBy = engineMethod('disconnectOwnedBy')
assert.match(
  engineDisconnectOwnedBy,
  /disconnectOwnedBy\(\s*ownerWebContentsId: number\s*\)[\s\S]*clearRemoteInputSession\(\s*ownerWebContentsId\s*\)/
)
// Both owner-scoped teardowns belong to this method; either one alone leaves sessions live.
assert.match(
  engineDisconnectOwnedBy,
  /this\s*\.\s*sessions\s*\.\s*disconnectByOwner\(\s*ownerWebContentsId\s*\)/
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

// --- Inbound Mesh task admission -------------------------------------------
// A task is a second way into this machine, so it gets its own gates: the
// durable mode, exclusivity against a live session, and the same autonomy
// quota. None of it may authorize remote input.

const receipts: MeshTaskReceiptRequest[] = []
setMeshTaskReceiptPublisher((receipt) => {
  receipts.push(receipt)
})
resetRemoteMeshTasks()

function dispatch(taskId: string, sessionId: string): MeshTaskReceiptDelivery {
  return {
    cursor: 1,
    protocolVersion: 'v0alpha2',
    eventId: `event-${taskId}`,
    subjectNodeId: 'node-peer',
    targetNodeId: 'node-desktop',
    sessionId,
    sequence: 1,
    type: 'task.requested',
    payload: { task_id: taskId, task_text: 'list the files' },
    capabilities: ['task.execute'],
    signature: 'verified-before-this-point',
    ticket: 'verified-before-this-point'
  }
}

function lastReceipt(): MeshTaskReceiptRequest | undefined {
  return receipts[receipts.length - 1]
}

applyAccessMode('none')
resetRemoteMeshTasks()

// Access off: a verified request is still recorded, but nothing may admit it.
assert.equal(recordVerifiedMeshTask(dispatch('task-off', 'session-off')).status, 'pending')
assert.deepEqual(decideRemoteMeshTask('task-off', true), {
  accepted: false,
  taskId: 'task-off',
  reason: 'access-disabled'
})

// Attended: only an explicit yes admits, and it never auto-approves a tool.
applyAccessMode('attended')
recordVerifiedMeshTask(dispatch('task-decline', 'session-decline'))
assert.deepEqual(decideRemoteMeshTask('task-decline', false), {
  accepted: false,
  taskId: 'task-decline',
  reason: 'user-rejected'
})
assert.equal(lastReceipt()?.state, 'rejected')
assert.deepEqual(decideRemoteMeshTask('task-decline', true), {
  accepted: false,
  taskId: 'task-decline',
  reason: 'already-decided'
})

recordVerifiedMeshTask(dispatch('task-attended', 'session-attended'))
// Delivery alone must not admit anything while a user is present, and the
// unconfirmed path must refuse even when called directly.
assert.equal(
  listRemoteMeshTasks().find((task) => task.taskId === 'task-attended')?.status,
  'pending'
)
assert.deepEqual(admitRemoteTask('session-attended', false), {
  admitted: false,
  reason: 'confirmation-required'
})
const attended = decideRemoteMeshTask('task-attended', true)
assert.equal(attended.accepted, true)
assert.equal(attended.accepted && attended.automatic, false)
assert.equal(accessSnapshot().sessionId, 'session-attended')
assert.equal(bindRunToSession('run-attended'), 'session-attended')
assert.deepEqual(requestAutoApproval('run-attended'), {
  approved: false,
  reason: 'not-unattended'
})
// Admitting a task is not authorizing input: the two paths stay independent.
assert.equal(isInputSessionAuthorized('session-attended'), false)

assert.equal(startRemoteMeshTask('task-attended', 'run-attended').success, true)
assert.equal(startRemoteMeshTask('task-attended', 'run-attended').success, false)
assert.equal(lastReceipt()?.state, 'started')

// A second session must not steal the live one: replacing it would withdraw
// approvals the first session is still relying on.
recordVerifiedMeshTask(dispatch('task-busy', 'session-busy'))
assert.deepEqual(decideRemoteMeshTask('task-busy', true), {
  accepted: false,
  taskId: 'task-busy',
  reason: 'session-busy'
})
assert.equal(accessSnapshot().sessionId, 'session-attended')

assert.equal(finishRemoteMeshTask('task-attended', 'completed', 'done').success, true)
assert.equal(lastReceipt()?.state, 'completed')
assert.equal(lastReceipt()?.resultText, 'done')
assert.equal(accessSnapshot().sessionId, null)
assert.equal(finishRemoteMeshTask('task-attended', 'completed').success, false)

// Unattended: admission is automatic and spends the same quota as a tool call.
applyAccessMode('unattended')
const before = accessSnapshot().autoApprovalsUsed
assert.equal(recordVerifiedMeshTask(dispatch('task-auto', 'session-auto')).status, 'admitted')
assert.equal(accessSnapshot().autoApprovalsUsed, before + 1)
assert.equal(bindRunToSession('run-auto'), 'session-auto')
assert.equal(requestAutoApproval('run-auto').approved, true)
assert.equal(isInputSessionAuthorized('session-auto'), false)

// A re-delivered event must not admit twice.
const used = accessSnapshot().autoApprovalsUsed
assert.equal(recordVerifiedMeshTask(dispatch('task-auto', 'session-auto')).status, 'admitted')
assert.equal(accessSnapshot().autoApprovalsUsed, used)
assert.equal(finishRemoteMeshTask('task-auto', 'completed').success, true)

// Revoking access withdraws the inbox too, including an admitted task that no
// window has claimed yet.
recordVerifiedMeshTask(dispatch('task-waiting', 'session-waiting'))
applyAccessMode('none')
assert.equal(
  listRemoteMeshTasks().find((task) => task.taskId === 'task-waiting')?.status,
  'expired'
)
assert.equal(lastReceipt()?.state, 'expired')
assert.equal(isInputSessionAuthorized('session-auto'), false)

// The quota is finite even when every admission is automatic.
applyAccessMode('unattended')
let exhausted = false
for (let index = 0; index < 250; index += 1) {
  const decision = admitRemoteTask('session-quota', false)
  if (!decision.admitted) {
    assert.equal(decision.reason, 'quota-exhausted')
    exhausted = true
    break
  }
}
assert.equal(exhausted, true)
applyAccessMode('none')
setMeshTaskReceiptPublisher(null)
resetRemoteMeshTasks()

const taskChannels = [
  'remote:task:list',
  'remote:task:decide',
  'remote:task:started',
  'remote:task:finish'
]
const remoteHandlers = await readCollapsedSource('src/main/ipc/remote-handlers.ts')
const channelRouting = await readCollapsedSource(
  'src/renderer/src/lib/ipc/messagepack-channel-routing.ts'
)
for (const channel of taskChannels) {
  assertIncludes(remoteHandlers, `'${channel}'`, 'task channel must stay registered')
  assertIncludes(channelRouting, `'${channel}'`, 'task channel must stay routable')
}
assertIncludes(
  remoteHandlers,
  'setMeshTaskReceiptPublisher',
  'task receipts must be published from the main process'
)
const accountClientSource = await readCollapsedSource('src/main/remote/account-client.ts')
assert.match(
  accountClientSource,
  /if \(\s*event\s*\.\s*type === 'task\.requested'\s*\)/,
  'inbound dispatches must take the dispatch verifier, not the receipt verifier'
)
assertIncludes(accountClientSource, 'verifyMeshTaskDispatch(', 'dispatch verification')
assert.match(
  accountClientSource,
  /capabilities:\s*\[\s*'mesh\.event\.receive'\s*\]/,
  'a receipt must not reuse the task.execute capability'
)
assert.match(
  await readCollapsedSource('src/main/remote/mesh-node.ts'),
  /\{\s*id: 'task\.execute',\s*risk: 'high',\s*version: '1'\s*\}/,
  'the desktop must advertise task.execute as high risk'
)

console.log('remote authorization verifier passed')
