import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const filesystem = await readFile('src/main/ipc/fs-handlers.ts', 'utf8')
const shell = await readFile('src/main/ipc/shell-handlers.ts', 'utf8')
const packageJson = await readFile('package.json', 'utf8')

assert.match(
  filesystem,
  /function isTrustedFilesystemIpcSender\(event: IpcMainInvokeEvent\): boolean/
)
assert.match(filesystem, /BrowserWindow\.fromWebContents\(event\.sender\)/)
assert.match(filesystem, /ownerWindow\.webContents === event\.sender/)
assert.match(filesystem, /event\.senderFrame === event\.sender\.mainFrame/)
assert.match(filesystem, /function registerTrustedFsMessagePackHandler<TArgs>/)
assert.match(filesystem, /if \(!isTrustedFilesystemIpcSender\(event\)\)/)
assert.match(filesystem, /Unauthorized filesystem IPC sender/)
assert.doesNotMatch(filesystem, /registerMessagePackHandler/)
assert.doesNotMatch(filesystem, /registerFsMessagePackHandler/)
assert.match(filesystem, /fs:select-folder'[\s\S]*BrowserWindow\.fromWebContents\(event\.sender\)/)
assert.match(filesystem, /fs:save-image'[\s\S]*BrowserWindow\.fromWebContents\(event\.sender\)/)
assert.match(
  filesystem,
  /fs:select-save-file'[\s\S]*BrowserWindow\.fromWebContents\(event\.sender\)/
)
assert.match(filesystem, /fs:select-file'[\s\S]*BrowserWindow\.fromWebContents\(event\.sender\)/)
assert.match(
  filesystem,
  /fs:import-profile-avatar'[\s\S]*BrowserWindow\.fromWebContents\(event\.sender\)/
)

assert.match(
  shell,
  /function getTrustedShellOwnerWindow\(\s*event: IpcMainInvokeEvent \| IpcMainEvent\s*\)/
)
assert.match(shell, /ownerWindow\.webContents === event\.sender/)
assert.match(shell, /event\.senderFrame === event\.sender\.mainFrame/)
assert.match(shell, /function registerTrustedShellMessagePackHandler<TArgs>/)
assert.match(shell, /Unauthorized shell IPC sender/)
assert.match(shell, /registerTrustedShellMessagePackHandler<ShellExecArgs>\('shell:exec'/)
assert.match(shell, /registerTrustedShellMessagePackHandler<string>\('shell:trashPath'/)
assert.match(shell, /runningShellProcesses\.get\(execId\)\?\.ownerWindowId/)
assert.match(shell, /BrowserWindow\.fromId\(ownerWindowId\)/)
assert.doesNotMatch(shell, /for \(const targetWindow of BrowserWindow\.getAllWindows\(\)\)/)
assert.doesNotMatch(
  shell,
  /BrowserWindow\.fromWebContents\(event\.sender\) \?\? BrowserWindow\.getAllWindows\(\)\[0\]/
)
assert.match(shell, /running\.ownerWindowId !== ownerWindow\.id/)
assert.match(shell, /if \(execId && runningShellProcesses\.has\(execId\)\)/)
assert.match(shell, /if \(!isTrustedShellIpcSender\(event\)\) return/)

assert.match(packageJson, /"verify:fs-shell-ipc-authorization"/)
assert.match(packageJson, /npm run verify:fs-shell-ipc-authorization/)

console.log('filesystem and shell IPC authorization verification passed')
