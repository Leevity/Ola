import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// Sender-trust and owner-isolation invariants are about tokens, not layout. The sources
// are read with whitespace collapsed so a re-wrap cannot turn the gate red; patterns
// tolerate a space wherever the formatter may break a line (wrapped signatures collapse
// to `fn( event: T ): boolean`, wrapped member chains to `a .b( c )`). Every ownership
// comparison below keeps its exact operands and operator. Nothing is line-anchored.
const terminal = await readCollapsedSource('src/main/ipc/terminal-handlers.ts')
const processes = await readCollapsedSource('src/main/ipc/process-manager.ts')
const packageJson = await readCollapsedSource('package.json')

// An unbounded window borrows the next handler's guard: terminal:input/resize/kill and
// process:kill/write all stayed green with their own authorization call deleted. Both
// files register exclusively through registerMessagePackHandler, so those markers are
// the only handler delimiters and every window must stop at the next one.
const handler = (source: string, channel: string): string => {
  const boundaries = [...source.matchAll(/registerMessagePackHandler/g)].map(
    (match) => match.index as number
  )
  const start = source.indexOf(`'${channel}'`)
  if (start < 0) throw new Error(`Missing ${channel} handler`)
  const owner = boundaries.filter((index) => index <= start).at(-1)
  const next = boundaries.find((index) => index > start)
  return source.slice(owner ?? start, next ?? source.length)
}

// The two sender-trust operands and the owner-workspace comparison each appear in more
// than one function, so a file-wide match lets a self-compare at one site hide behind
// the intact copy at another. Bind each to its own declaration body.
const functionBody = (source: string, name: string): string => {
  const start = source.search(new RegExp(`function ${name}\\(`))
  if (start < 0) throw new Error(`Missing ${name} declaration`)
  const next = [...source.matchAll(/(?:export\s+)?(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(/g)]
    .map((match) => match.index as number)
    .find((index) => index > start)
  return source.slice(start, next ?? source.length)
}

const terminalSender = functionBody(terminal, 'isTrustedTerminalIpcSender')
const processSender = functionBody(processes, 'isTrustedProcessIpcSender')
const terminalAuthorization = functionBody(terminal, 'isTerminalWorkspaceAuthorized')

assert.match(
  terminal,
  /function isTrustedTerminalIpcSender\(\s*event:\s*IpcMainInvokeEvent\s*\):\s*boolean/
)
assert.match(terminalSender, /event\.senderFrame\s*===\s*event\.sender\.mainFrame/)
assert.match(terminalSender, /ownerWindow\.webContents\s*===\s*event\.sender/)
assert.match(
  handler(terminal, 'terminal:create'),
  /isTrustedTerminalIpcSender\(\s*event\s*\)/,
  'terminal:create must check the terminal IPC sender'
)
assert.match(
  terminal,
  /function resolveSenderWorkspace\(\s*event:\s*IpcMainInvokeEvent\s*\):\s*string\s*\|\s*null/
)
assert.match(terminal, /function isTerminalWorkspaceAuthorized\(/)
assert.match(
  terminalAuthorization,
  /owner\.workspaceId\s*===\s*workspaceId/,
  'isTerminalWorkspaceAuthorized must compare the owner workspace, not itself'
)
assert.match(
  handler(terminal, 'terminal:input'),
  /isTerminalWorkspaceAuthorized\(\s*args\.id,\s*event\.sender\s*\)/,
  'terminal:input must authorize the target workspace'
)
assert.match(
  handler(terminal, 'terminal:resize'),
  /isTerminalWorkspaceAuthorized\(\s*args\.id,\s*event\.sender\s*\)/,
  'terminal:resize must authorize the target workspace'
)
assert.match(
  handler(terminal, 'terminal:kill'),
  /isTerminalWorkspaceAuthorized\(\s*args\.id,\s*event\.sender\s*\)/,
  'terminal:kill must authorize the target workspace'
)
assert.match(
  handler(terminal, 'terminal:get'),
  /isTerminalWorkspaceAuthorized\(\s*args\.id,\s*event\.sender\s*\)/,
  'terminal:get must authorize the target workspace'
)
assert.match(
  handler(terminal, 'terminal:list'),
  /terminalSessions\s*\.\s*list\(\s*workspaceId\s*\)[\s\S]*owner\?\.windowId\s*===\s*ownerWindowId[\s\S]*owner\.workspaceId\s*===\s*workspaceId/,
  'terminal:list must filter sessions by owner window and workspace'
)
assert.match(
  terminal,
  /export function hasActiveLocalTerminalSessions\(\s*workspaceId:\s*string\s*\)/
)

assert.match(
  processes,
  /function isTrustedProcessIpcSender\(\s*event:\s*IpcMainInvokeEvent\s*\):\s*boolean/
)
assert.match(processSender, /event\.senderFrame\s*===\s*event\.sender\.mainFrame/)
assert.match(processSender, /ownerWindow\.webContents\s*===\s*event\.sender/)
assert.match(
  handler(processes, 'process:spawn'),
  /isTrustedProcessIpcSender\(\s*event\s*\)/,
  'process:spawn must check the process IPC sender'
)
assert.match(
  processes,
  /function isManagedProcessOwnedBy\(\s*managed:\s*ManagedProcess,\s*sender\?:\s*WebContents\s*\|\s*null\s*\):\s*boolean/
)
assert.match(
  handler(processes, 'process:kill'),
  /isManagedProcessOwnedBy\(\s*managed,\s*event\.sender\s*\)/,
  'process:kill must scope ownership to the sender window'
)
assert.match(
  handler(processes, 'process:write'),
  /isManagedProcessOwnedBy\(\s*managed,\s*event\.sender\s*\)/,
  'process:write must scope ownership to the sender window'
)
assert.match(
  handler(processes, 'process:status'),
  /isManagedProcessOwnedBy\(\s*managed,\s*event\.sender\s*\)/,
  'process:status must scope ownership to the sender window'
)
assert.match(
  handler(processes, 'process:list'),
  /m\.windowId\s*!==\s*ownerWindowId/,
  'process:list must hide processes owned by another window'
)

assert.match(packageJson, /"verify:terminal-owner-isolation"/)
assert.match(packageJson, /npm run verify:terminal-owner-isolation/)

console.log('terminal owner isolation verification passed')
