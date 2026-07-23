import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const apiProxy = readFileSync('src/main/ipc/api-proxy.ts', 'utf8')
const oauthHandlers = readFileSync('src/main/ipc/oauth-handlers.ts', 'utf8')
const packageJson = readFileSync('package.json', 'utf8')

assert.match(apiProxy, /function isTrustedApiIpcSender\(event: IpcMainInvokeEvent\): boolean/)
assert.match(apiProxy, /ownerWindow\.webContents === event\.sender/)
assert.match(apiProxy, /event\.senderFrame === event\.sender\.mainFrame/)
assert.match(apiProxy, /api:request'[\s\S]*isTrustedApiIpcSender\(event\)/)
assert.match(apiProxy, /Unauthorized API IPC sender/)

assert.match(
  oauthHandlers,
  /function isTrustedOauthIpcSender\(event: IpcMainInvokeEvent\): boolean/
)
assert.match(oauthHandlers, /ownerWindow\.webContents === event\.sender/)
assert.match(oauthHandlers, /event\.senderFrame === event\.sender\.mainFrame/)
assert.match(oauthHandlers, /oauth:start'[\s\S]*isTrustedOauthIpcSender\(event\)/)
assert.match(oauthHandlers, /oauth:stop'[\s\S]*isTrustedOauthIpcSender\(event\)/)
assert.match(oauthHandlers, /existing\.sender !== event\.sender/)
assert.match(oauthHandlers, /Unauthorized OAuth IPC sender/)
assert.match(oauthHandlers, /OAuth request is owned by another window/)

assert.match(packageJson, /"verify:api-oauth-ipc-authorization"/)
assert.match(packageJson, /npm run verify:api-oauth-ipc-authorization/)

console.log('API and OAuth IPC authorization verification passed')
