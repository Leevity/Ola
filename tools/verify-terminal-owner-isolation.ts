import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const terminal = await readFile('src/main/ipc/terminal-handlers.ts', 'utf8')
const processes = await readFile('src/main/ipc/process-manager.ts', 'utf8')
const packageJson = await readFile('package.json', 'utf8')

assert.match(terminal, /function isTrustedTerminalIpcSender\(event: IpcMainInvokeEvent\): boolean/)
assert.match(terminal, /event\.senderFrame === event\.sender\.mainFrame/)
assert.match(terminal, /terminal:create'[\s\S]*isTrustedTerminalIpcSender\(event\)/)
assert.match(
  terminal,
  /function resolveSenderWorkspace\(event: IpcMainInvokeEvent\): string \| null/
)
assert.match(terminal, /function isTerminalWorkspaceAuthorized\(/)
assert.match(
  terminal,
  /terminal:input'[\s\S]*isTerminalWorkspaceAuthorized\(args\.id, event\.sender\)/
)
assert.match(
  terminal,
  /terminal:resize'[\s\S]*isTerminalWorkspaceAuthorized\(args\.id, event\.sender\)/
)
assert.match(
  terminal,
  /terminal:kill'[\s\S]*isTerminalWorkspaceAuthorized\(args\.id, event\.sender\)/
)
assert.match(
  terminal,
  /terminal:get'[\s\S]*isTerminalWorkspaceAuthorized\(args\.id, event\.sender\)/
)
assert.match(
  terminal,
  /terminal:list'[\s\S]*terminalSessions\.list\(workspaceId\)[\s\S]*owner\?\.windowId === ownerWindowId[\s\S]*owner\.workspaceId === workspaceId/
)
assert.match(terminal, /export function hasActiveLocalTerminalSessions\(workspaceId: string\)/)

assert.match(processes, /function isTrustedProcessIpcSender\(event: IpcMainInvokeEvent\): boolean/)
assert.match(processes, /event\.senderFrame === event\.sender\.mainFrame/)
assert.match(processes, /process:spawn'[\s\S]*isTrustedProcessIpcSender\(event\)/)
assert.match(
  processes,
  /function isManagedProcessOwnedBy\(managed: ManagedProcess, sender\?: WebContents \| null\): boolean/
)
assert.match(processes, /process:kill'[\s\S]*isManagedProcessOwnedBy\(managed, event\.sender\)/)
assert.match(processes, /process:write'[\s\S]*isManagedProcessOwnedBy\(managed, event\.sender\)/)
assert.match(processes, /process:status'[\s\S]*isManagedProcessOwnedBy\(managed, event\.sender\)/)
assert.match(processes, /process:list'[\s\S]*m\.windowId !== ownerWindowId/)

assert.match(packageJson, /"verify:terminal-owner-isolation"/)
assert.match(packageJson, /npm run verify:terminal-owner-isolation/)

console.log('terminal owner isolation verification passed')
