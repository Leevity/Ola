import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const inputHandlers = await readFile('src/main/ipc/input-handlers.ts', 'utf8')
const screenshotHandlers = await readFile('src/main/ipc/screenshot-handlers.ts', 'utf8')
const packageJson = await readFile('package.json', 'utf8')

for (const handlers of [inputHandlers, screenshotHandlers]) {
  assert.match(handlers, /function isTrustedDesktopIpcSender\(event: IpcMainInvokeEvent\): boolean/)
  assert.match(handlers, /BrowserWindow\.fromWebContents\(event\.sender\)/)
  assert.match(handlers, /ownerWindow\.webContents === event\.sender/)
  assert.match(handlers, /event\.senderFrame === event\.sender\.mainFrame/)
}

assert.match(inputHandlers, /DESKTOP_INPUT_STATUS[\s\S]*isTrustedDesktopIpcSender\(event\)/)
assert.match(inputHandlers, /DESKTOP_INPUT_CLICK[\s\S]*isTrustedDesktopIpcSender\(event\)/)
assert.match(inputHandlers, /DESKTOP_INPUT_TYPE[\s\S]*isTrustedDesktopIpcSender\(event\)/)
assert.match(inputHandlers, /DESKTOP_INPUT_SCROLL[\s\S]*isTrustedDesktopIpcSender\(event\)/)
assert.match(inputHandlers, /available: false, error: UNAUTHORIZED_DESKTOP_IPC_ERROR/)
assert.match(inputHandlers, /success: false, error: UNAUTHORIZED_DESKTOP_IPC_ERROR/)
assert.match(
  screenshotHandlers,
  /DESKTOP_SCREENSHOT_CAPTURE[\s\S]*isTrustedDesktopIpcSender\(event\)/
)
assert.match(screenshotHandlers, /success: false, error: 'Unauthorized desktop IPC sender'/)
assert.match(packageJson, /"verify:desktop-ipc-authorization"/)
assert.match(packageJson, /npm run verify:desktop-ipc-authorization/)

console.log('desktop IPC authorization verification passed')
