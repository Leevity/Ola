import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// Credential, SSH and remote sender-trust plus workspace isolation are security
// invariants. Every assertion keeps its exact meaning; only layout dependence is
// removed. Sources are read with whitespace collapsed, and patterns tolerate `\s*`
// wherever Biome may wrap a signature, a generic argument list, a parameter list or
// an operator. Negative assertions are widened the same way so a re-wrap cannot let
// a forbidden broadcast slip past them.
const credentials = await readCollapsedSource('src/main/ipc/credentials-handlers.ts')
const ssh = await readCollapsedSource('src/main/ipc/ssh-handlers.ts')
const remote = await readCollapsedSource('src/main/ipc/remote-handlers.ts')
const remoteEngine = await readCollapsedSource('src/main/remote/engine.ts')
const packageJson = await readCollapsedSource('package.json')

// Each sender-trust body is bounded by the next function declaration. File-global
// operand checks only ever covered SSH's frame comparison: deleting the same check
// from the credentials or remote helper stayed green. `(?![\w])` stops `event.sender`
// from being satisfied by `event.senderFrame`.
const trustedSenderBody = (source: string, helper: string): string => {
  const start = source.indexOf(`function ${helper}(`)
  if (start < 0) throw new Error(`Missing ${helper}`)
  const next = source.indexOf(' function ', start + 1)
  return source.slice(start, next < 0 ? source.length : next)
}

for (const [name, source, helper, error] of [
  [
    'credentials',
    credentials,
    'isTrustedCredentialsIpcSender',
    'Unauthorized credential IPC sender'
  ],
  ['SSH', ssh, 'isTrustedSshIpcSender', 'Unauthorized SSH IPC sender'],
  ['remote', remote, 'isTrustedRemoteIpcSender', 'Unauthorized remote IPC sender']
] as const) {
  const body = trustedSenderBody(source, helper)
  assert.match(body, new RegExp(`function ${helper}\\(\\s*event:\\s*IpcMainInvokeEvent`))
  assert.match(body, /\):\s*boolean\s*\{/, `${name} sender trust must return a boolean`)
  assert.match(body, /ownerWindow\s*!==\s*null/)
  assert.match(body, /!ownerWindow\s*\.\s*isDestroyed\(\s*\)/)
  assert.match(body, /ownerWindow\s*\.\s*webContents\s*===\s*event\s*\.\s*sender(?![\w])/)
  assert.match(
    body,
    /event\s*\.\s*senderFrame\s*===\s*event\s*\.\s*sender\s*\.\s*mainFrame(?![\w])/
  )
  assert.match(source, new RegExp(error))
  assert.match(
    source,
    new RegExp(`if \\(\\s*!${helper}\\(\\s*event\\s*\\)\\s*\\)`),
    `${name} IPC gate missing`
  )
}

assert.match(
  trustedSenderBody(ssh, 'isTrustedSshIpcSender'),
  /isTrustedRendererIpcEvent\(\s*event\s*\)/
)

assert.match(
  credentials,
  /function registerTrustedCredentialsMessagePackHandler<\s*TArgs,\s*TResult =\s*unknown\s*>/
)
assert.match(credentials, /registerTrustedCredentialsMessagePackHandler<\s*StoreCredentialRequest/)
assert.match(credentials, /registerTrustedCredentialsMessagePackHandler<\s*FillPasswordRequest/)
assert.doesNotMatch(credentials, /(?<!Raw)registerMessagePackHandler</)

assert.match(ssh, /function registerSshMessagePackHandler<\s*TArgs\s*>/)
assert.match(
  ssh,
  /ipcMain\.handle\(\s*toMessagePackChannel\(\s*channel\s*\),\s*async \(\s*event,\s*bytes:\s*Uint8Array\s*\)/
)
assert.match(ssh, /registerSshMessagePackHandler<\s*SshExecArgs\s*>\(\s*'ssh:exec'/)
assert.match(ssh, /registerSshMessagePackHandler<\s*SshWriteFileArgs\s*>\(\s*'ssh:fs:write-file'/)
assert.match(ssh, /ownerWindowId:\s*number/)
assert.match(ssh, /ownerWindowId:\s*ownerWindow\.id/)
assert.match(ssh, /function isSshSessionOwnedBy\(/)
assert.match(ssh, /session\.ownerWindowId\s*===\s*ownerWindow\.id/)
assert.match(ssh, /sendSshSessionMessage\(\s*session,\s*'ssh:output'/)
assert.match(ssh, /sendSshSessionMessage\(\s*session,\s*'ssh:status'/)
assert.match(ssh, /SSH session is owned by another window/)
// ssh:data and ssh:resize are ipcMain.on listeners, and their ownership check is the
// 3-arg workspace-scoped form. Bound each listener by the next registration: the old
// unbounded window reached ssh:disconnect's 2-arg call, so the workspace-scoped check
// was never actually asserted and deleting it stayed green.
const sshBoundaries = [
  ...ssh.matchAll(/ipcMain\s*\.\s*on\(\s*toMessagePackChannel\(|registerSshMessagePackHandler/g)
].map((match) => match.index as number)
const sshListener = (channel: string): string => {
  const start = ssh.indexOf(`'${channel}'`)
  if (start < 0) throw new Error(`Missing ${channel} listener`)
  const owner = sshBoundaries.filter((index) => index <= start).at(-1)
  const next = sshBoundaries.find((index) => index > start)
  return ssh.slice(owner ?? start, next ?? ssh.length)
}
const workspaceScopedSshOwnership =
  /isSshSessionOwnedBy\(\s*event,\s*args\.sessionId,\s*args\.workspaceId\s*\?\?\s*'local-personal'\s*\)/
assert.match(
  sshListener('ssh:data'),
  workspaceScopedSshOwnership,
  'ssh:data must scope session ownership to the requested workspace'
)
assert.match(
  sshListener('ssh:resize'),
  workspaceScopedSshOwnership,
  'ssh:resize must scope session ownership to the requested workspace'
)
assert.match(
  sshListener('ssh:session:list'),
  /session\.ownerWindowId\s*!==\s*ownerWindow\.id/,
  'ssh:session:list must filter out sessions owned by another window'
)
assert.match(
  sshListener('ssh:diagnostics:list'),
  /entry\.ownerWindowId\s*===\s*ownerWindow\.id/,
  'ssh:diagnostics:list must keep only entries owned by this window'
)
assert.match(ssh, /ownerWindowId:\s*number/)
assert.match(
  ssh,
  /function isSshTaskOwnedBy\(\s*event:\s*IpcMainInvokeEvent,\s*ownerWindowId:\s*number\s*\)/
)
assert.match(ssh, /sendUploadEvent\(/)
assert.match(ssh, /sendTransferEvent\(/)
// `ownerWindowId: ownerWindow.id` and the task-ownership error string each occur at
// three sites, so an unbounded window accepted a neighbour's evidence: neutralizing
// upload:start's own owner binding stayed green. Bound every channel to its handler.
assert.match(
  sshListener('ssh:fs:upload:start'),
  /ownerWindowId:\s*ownerWindow\.id/,
  'ssh:fs:upload:start must record the owning window'
)
assert.match(
  sshListener('ssh:fs:transfer:start'),
  /ownerWindowId:\s*ownerWindow\.id/,
  'ssh:fs:transfer:start must record the owning window'
)
assert.match(
  sshListener('ssh:fs:upload:cancel'),
  /SSH task is owned by another window/,
  'ssh:fs:upload:cancel must reject a task owned by another window'
)
assert.match(
  sshListener('ssh:fs:transfer:cancel'),
  /SSH task is owned by another window/,
  'ssh:fs:transfer:cancel must reject a task owned by another window'
)
assert.doesNotMatch(ssh, /safeSendMessagePackToAllWindows\(\s*'ssh:fs:(?:upload|transfer):events'/)
assert.doesNotMatch(ssh, /broadcastToRenderer\(\s*'ssh:(?:output|status)/)

assert.match(
  remote,
  /function registerTrustedRemoteMessagePackHandler<\s*TArgs,\s*TResult =\s*unknown\s*>/
)
assert.match(remote, /registerTrustedRemoteMessagePackHandler<\s*RemoteConnectionCreateRequest/)
assert.match(remote, /registerTrustedRemoteMessagePackHandler<\s*RemoteConnectInput/)
assert.match(remote, /registerTrustedRemoteMessagePackHandler<\s*RemoteInputEnvelope/)
// Remote input guards are asserted in their negated form, inside their own handler.
// Dropping the `!` inverts the ownership check while leaving the symbol in place, and
// the old bare-token window stayed green for both channels. All three registration
// forms must be boundaries, or a window can still run past its own handler.
const remoteBoundaries = [...remote.matchAll(/register[A-Za-z]*MessagePackHandler/g)].map(
  (match) => match.index as number
)
const remoteHandler = (channel: string): string => {
  const start = remote.indexOf(`'${channel}'`)
  if (start < 0) throw new Error(`Missing ${channel} handler`)
  const owner = remoteBoundaries.filter((index) => index <= start).at(-1)
  const next = remoteBoundaries.find((index) => index > start)
  return remote.slice(owner ?? start, next ?? remote.length)
}
assert.match(
  remoteHandler('remote:input:set-session'),
  /if\s*\(\s*!remoteControlEngine\s*\.\s*sessions\s*\.\s*isOwnedBy\(\s*sessionId,\s*ownerWebContentsId\s*\)\s*\)/,
  'remote:input:set-session must reject a session owned by another window'
)
assert.match(
  remoteHandler('remote:input:dispatch'),
  /if\s*\(\s*!isRemoteInputSessionOwnedBy\(\s*args\?\.sessionId,\s*ownerWebContentsId\s*\)\s*\)/,
  'remote:input:dispatch must reject input from a window that does not own the session'
)
// Incoming Ola sessions delegate ownership checks to the engine; the handler
// must pass its trusted sender identity rather than a renderer-supplied owner.
assert.match(remote, /createIncomingOlaDeviceSession\(\s*sessionId,\s*ownerWebContentsId,/)
assert.match(
  remoteEngine,
  /!this\s*\.\s*sessions\s*\.\s*isOwnedBy\(\s*sessionId,\s*ownerWebContentsId\s*\)[\s\S]*Remote session is owned by another window/
)
assert.match(remote, /Remote input is owned by another window/)
assert.match(
  remoteEngine,
  /clearRemoteInputSessionIfOwned\(\s*sessionId,\s*ownerWebContentsId\s*\)/
)
assert.match(remoteEngine, /clearRemoteInputSession\(\s*ownerWebContentsId\s*\)/)
assert.doesNotMatch(remote, /(?<!Raw)registerMessagePackHandler</)

assert.match(packageJson, /"verify:credential-ssh-remote-ipc-authorization"/)
assert.match(packageJson, /npm run verify:credential-ssh-remote-ipc-authorization/)

console.log('credential, SSH, and remote IPC authorization verification passed')
