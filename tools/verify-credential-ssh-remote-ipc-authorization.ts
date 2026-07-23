import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const credentials = readFileSync('src/main/ipc/credentials-handlers.ts', 'utf8')
const ssh = readFileSync('src/main/ipc/ssh-handlers.ts', 'utf8')
const remote = readFileSync('src/main/ipc/remote-handlers.ts', 'utf8')
const remoteEngine = readFileSync('src/main/remote/engine.ts', 'utf8')
const packageJson = readFileSync('package.json', 'utf8')

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
  assert.match(source, new RegExp(`function ${helper}\\(event: IpcMainInvokeEvent`))
  assert.match(source, /ownerWindow\.webContents === event\.sender/)
  assert.match(source, new RegExp(error))
  assert.match(source, new RegExp(`if \\(!${helper}\\(event\\)\\)`), `${name} IPC gate missing`)
}

assert.match(ssh, /event\.senderFrame === event\.sender\.mainFrame/)

assert.match(
  credentials,
  /function registerTrustedCredentialsMessagePackHandler<TArgs, TResult = unknown>/
)
assert.match(credentials, /registerTrustedCredentialsMessagePackHandler<StoreCredentialRequest/)
assert.match(credentials, /registerTrustedCredentialsMessagePackHandler<FillPasswordRequest/)
assert.doesNotMatch(credentials, /(?<!Raw)registerMessagePackHandler</)

assert.match(ssh, /function registerSshMessagePackHandler<TArgs>/)
assert.match(
  ssh,
  /ipcMain\.handle\(toMessagePackChannel\(channel\), async \(event, bytes: Uint8Array\)/
)
assert.match(ssh, /registerSshMessagePackHandler<SshExecArgs>\('ssh:exec'/)
assert.match(ssh, /registerSshMessagePackHandler<SshWriteFileArgs>\('ssh:fs:write-file'/)
assert.match(ssh, /ownerWindowId: number/)
assert.match(ssh, /ownerWindowId: ownerWindow\.id/)
assert.match(ssh, /function isSshSessionOwnedBy\(/)
assert.match(ssh, /session\.ownerWindowId === ownerWindow\.id/)
assert.match(ssh, /sendSshSessionMessage\(session, 'ssh:output'/)
assert.match(ssh, /sendSshSessionMessage\(session, 'ssh:status'/)
assert.match(ssh, /SSH session is owned by another window/)
assert.match(ssh, /ssh:data'[\s\S]*isSshSessionOwnedBy\(event, args\.sessionId\)/)
assert.match(ssh, /ssh:resize'[\s\S]*isSshSessionOwnedBy\(event, args\.sessionId\)/)
assert.match(ssh, /ssh:session:list'[\s\S]*session\.ownerWindowId !== ownerWindow\.id/)
assert.match(ssh, /ssh:diagnostics:list'[\s\S]*entry\.ownerWindowId === ownerWindow\.id/)
assert.match(ssh, /ownerWindowId: number/)
assert.match(ssh, /function isSshTaskOwnedBy\(event: IpcMainInvokeEvent, ownerWindowId: number\)/)
assert.match(ssh, /sendUploadEvent\(/)
assert.match(ssh, /sendTransferEvent\(/)
assert.match(ssh, /ssh:fs:upload:start'[\s\S]*ownerWindowId: ownerWindow\.id/)
assert.match(ssh, /ssh:fs:transfer:start'[\s\S]*ownerWindowId: ownerWindow\.id/)
assert.match(ssh, /ssh:fs:upload:cancel'[\s\S]*SSH task is owned by another window/)
assert.match(ssh, /ssh:fs:transfer:cancel'[\s\S]*SSH task is owned by another window/)
assert.doesNotMatch(ssh, /safeSendMessagePackToAllWindows\('ssh:fs:(?:upload|transfer):events'/)
assert.doesNotMatch(ssh, /broadcastToRenderer\('ssh:(?:output|status)/)

assert.match(remote, /function registerTrustedRemoteMessagePackHandler<TArgs, TResult = unknown>/)
assert.match(remote, /registerTrustedRemoteMessagePackHandler<RemoteConnectionCreateRequest/)
assert.match(remote, /registerTrustedRemoteMessagePackHandler<RemoteConnectInput/)
assert.match(remote, /registerTrustedRemoteMessagePackHandler<\s*RemoteInputEnvelope/)
assert.match(remote, /remote:input:set-session'[\s\S]*remoteControlEngine\.sessions\.isOwnedBy/)
assert.match(remote, /remote:input:dispatch'[\s\S]*isRemoteInputSessionOwnedBy/)
assert.match(remote, /Remote session is owned by another window/)
assert.match(remote, /Remote input is owned by another window/)
assert.match(remoteEngine, /clearRemoteInputSessionIfOwned\(sessionId, ownerWebContentsId\)/)
assert.match(remoteEngine, /clearRemoteInputSession\(ownerWebContentsId\)/)
assert.doesNotMatch(remote, /(?<!Raw)registerMessagePackHandler</)

assert.match(packageJson, /"verify:credential-ssh-remote-ipc-authorization"/)
assert.match(packageJson, /npm run verify:credential-ssh-remote-ipc-authorization/)

console.log('credential, SSH, and remote IPC authorization verification passed')
