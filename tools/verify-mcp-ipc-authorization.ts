import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const handlers = await readFile('src/main/ipc/mcp-handlers.ts', 'utf8')
const packageJson = await readFile('package.json', 'utf8')

assert.match(handlers, /function isTrustedMcpIpcSender\(event: IpcMainInvokeEvent\): boolean/)
assert.match(handlers, /BrowserWindow\.fromWebContents\(event\.sender\)/)
assert.match(handlers, /ownerWindow\.webContents === event\.sender/)
assert.match(handlers, /event\.senderFrame === event\.sender\.mainFrame/)
assert.match(handlers, /if \(!isTrustedMcpIpcSender\(event\)\)/)
assert.match(handlers, /Unauthorized MCP IPC sender/)
assert.match(packageJson, /"verify:mcp-ipc-authorization"/)
assert.match(packageJson, /npm run verify:mcp-ipc-authorization/)

console.log('MCP IPC authorization verification passed')
