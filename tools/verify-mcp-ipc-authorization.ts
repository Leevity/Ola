import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// Sender-trust invariants are about tokens, not layout: the formatter may wrap the
// signature, the argument list or a member chain, so every pattern tolerates a space
// wherever a line break is allowed. The set of checks is unchanged.
const handlers = await readCollapsedSource('src/main/ipc/mcp-handlers.ts')
const packageJson = await readCollapsedSource('package.json')

assert.match(
  handlers,
  /function isTrustedMcpIpcSender\(\s*event: IpcMainInvokeEvent\s*\):\s*boolean/
)
// A second fromWebContents(event.sender) call exists later in the file, so the trust
// checks are bound to isTrustedMcpIpcSender rather than matched file-globally.
const declarations = [...handlers.matchAll(/function\s+[A-Za-z_$][\w$]*/g)].map(
  (match) => match.index as number
)
const trustStart = handlers.search(/function\s+isTrustedMcpIpcSender\s*\(/)
if (trustStart < 0) throw new Error('Missing isTrustedMcpIpcSender')
const trustNext = declarations.find((index) => index > trustStart)
const trust = handlers.slice(trustStart, trustNext ?? handlers.length)
assert.match(trust, /BrowserWindow\s*\.\s*fromWebContents\(\s*event\s*\.\s*sender\s*\)/)
// `sender` prefixes `senderFrame` and `mainFrame` prefixes `mainFrameId`, so without a
// token boundary a comparison against the wrong property still satisfies the pattern.
assert.match(trust, /ownerWindow\s*\.\s*webContents === event\s*\.\s*sender(?![\w])/)
assert.match(trust, /event\s*\.\s*senderFrame === event\s*\.\s*sender\s*\.\s*mainFrame(?![\w])/)
assert.match(handlers, /if \(\s*!isTrustedMcpIpcSender\(\s*event\s*\)\s*\)/)
assert.match(handlers, /Unauthorized MCP IPC sender/)
assert.match(packageJson, /"verify:mcp-ipc-authorization"/)
assert.match(packageJson, /npm run verify:mcp-ipc-authorization/)

console.log('MCP IPC authorization verification passed')
