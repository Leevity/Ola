import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// Sender-trust is a security invariant, so every assertion below is kept verbatim in
// meaning. Only layout dependence is removed: the sources are read with whitespace
// collapsed and each pattern tolerates `\s*` where Biome may wrap a signature, a
// parameter list or an operator. No assertion is relaxed.
const apiProxy = await readCollapsedSource('src/main/ipc/api-proxy.ts')
const oauthHandlers = await readCollapsedSource('src/main/ipc/oauth-handlers.ts')
const packageJson = await readCollapsedSource('package.json')

assert.match(
  apiProxy,
  /function isTrustedApiIpcSender\(\s*event:\s*IpcMainInvokeEvent\s*\):\s*boolean/
)
assert.match(apiProxy, /ownerWindow\.webContents\s*===\s*event\.sender/)
assert.match(apiProxy, /event\.senderFrame\s*===\s*event\.sender\.mainFrame/)
assert.match(apiProxy, /api:request'[\s\S]*isTrustedApiIpcSender\(\s*event\s*\)/)
assert.match(apiProxy, /Unauthorized API IPC sender/)

assert.match(
  oauthHandlers,
  /function isTrustedOauthIpcSender\(\s*event:\s*IpcMainInvokeEvent\s*\):\s*boolean/
)
assert.match(oauthHandlers, /ownerWindow\.webContents\s*===\s*event\.sender/)
assert.match(oauthHandlers, /event\.senderFrame\s*===\s*event\.sender\.mainFrame/)
// An open-ended window from oauth:start reaches oauth:stop's trust call, so deleting
// oauth:start's own check stayed green. Bound each handler by the next registration.
const oauthRegistrations = [...oauthHandlers.matchAll(/registerMessagePackHandler/g)].map(
  (match) => match.index as number
)
const oauthHandler = (channel: string): string => {
  const start = oauthHandlers.indexOf(`'${channel}'`)
  if (start < 0) throw new Error(`Missing ${channel} handler`)
  const owner = oauthRegistrations.filter((index) => index <= start).at(-1)
  const next = oauthRegistrations.find((index) => index > start)
  return oauthHandlers.slice(owner ?? start, next ?? oauthHandlers.length)
}
const oauthStart = oauthHandler('oauth:start')
const oauthStop = oauthHandler('oauth:stop')
assert.match(oauthStart, /isTrustedOauthIpcSender\(\s*event\s*\)/)
assert.match(oauthStop, /isTrustedOauthIpcSender\(\s*event\s*\)/)
// The ownership refusal has two sites; a file-global token check let either one be
// deleted while the other kept the gate green. (?![\w]) stops event.senderFrame satisfying it.
const oauthOwnership = /existing\.sender\s*!==\s*event\.sender(?![\w])/
assert.match(oauthStart, oauthOwnership)
assert.match(oauthStop, oauthOwnership)
assert.match(oauthHandlers, /Unauthorized OAuth IPC sender/)
assert.match(oauthHandlers, /OAuth request is owned by another window/)

assert.match(packageJson, /"verify:api-oauth-ipc-authorization"/)
assert.match(packageJson, /npm run verify:api-oauth-ipc-authorization/)

console.log('API and OAuth IPC authorization verification passed')
