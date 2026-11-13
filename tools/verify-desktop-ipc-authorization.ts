import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// Desktop IPC sender trust is a security invariant about tokens, not layout. The sources
// are read with whitespace collapsed so a re-wrap cannot turn the gate red; patterns
// tolerate a space wherever the formatter may break a line (a wrapped signature collapses
// to `fn( event: T ): boolean`, a wrapped result object to `{ success: false, error: … }`).
// The owner-window and main-frame comparisons keep their exact operands and operators.
const inputHandlers = await readCollapsedSource('src/main/ipc/input-handlers.ts')
const screenshotHandlers = await readCollapsedSource('src/main/ipc/screenshot-handlers.ts')
const packageJson = await readCollapsedSource('package.json')

for (const handlers of [inputHandlers, screenshotHandlers]) {
  assert.match(
    handlers,
    /function isTrustedDesktopIpcSender\(\s*event:\s*IpcMainInvokeEvent\s*\):\s*boolean/
  )
  assert.match(handlers, /BrowserWindow\.fromWebContents\(\s*event\.sender\s*\)/)
  assert.match(handlers, /ownerWindow\.webContents\s*===\s*event\.sender/)
  assert.match(handlers, /event\.senderFrame\s*===\s*event\.sender\.mainFrame/)
}

// These channels are imported constants, so each name also occurs in the import list;
// only its occurrence inside a registration identifies the handler. An unbounded window
// let DESKTOP_INPUT_CLICK borrow a neighbour's sender check and stay green when its own
// guard was deleted, so each window stops at the next registration marker.
const inputBoundaries = [...inputHandlers.matchAll(/registerMessagePackHandler/g)].map(
  (match) => match.index as number
)
const inputHandler = (channel: string): string => {
  const start = inputHandlers.search(
    new RegExp(`registerMessagePackHandler<[^>]*>\\(\\s*${channel}\\s*,`)
  )
  if (start < 0) throw new Error(`Missing ${channel} handler`)
  const owner = inputBoundaries.filter((index) => index <= start).at(-1)
  const next = inputBoundaries.find((index) => index > start)
  return inputHandlers.slice(owner ?? start, next ?? inputHandlers.length)
}
const desktopSenderCheck = /isTrustedDesktopIpcSender\(\s*event\s*\)/

assert.match(
  inputHandler('DESKTOP_INPUT_STATUS'),
  desktopSenderCheck,
  'DESKTOP_INPUT_STATUS must check the desktop IPC sender'
)
assert.match(
  inputHandler('DESKTOP_INPUT_CLICK'),
  desktopSenderCheck,
  'DESKTOP_INPUT_CLICK must check the desktop IPC sender'
)
assert.match(
  inputHandler('DESKTOP_INPUT_TYPE'),
  desktopSenderCheck,
  'DESKTOP_INPUT_TYPE must check the desktop IPC sender'
)
assert.match(
  inputHandler('DESKTOP_INPUT_SCROLL'),
  desktopSenderCheck,
  'DESKTOP_INPUT_SCROLL must check the desktop IPC sender'
)
assert.match(inputHandlers, /available:\s*false,\s*error:\s*UNAUTHORIZED_DESKTOP_IPC_ERROR/)
assert.match(inputHandlers, /success:\s*false,\s*error:\s*UNAUTHORIZED_DESKTOP_IPC_ERROR/)
assert.match(
  screenshotHandlers,
  /DESKTOP_SCREENSHOT_CAPTURE[\s\S]*isTrustedDesktopIpcSender\(\s*event\s*\)/
)
assert.match(screenshotHandlers, /success:\s*false,\s*error:\s*'Unauthorized desktop IPC sender'/)
assert.match(packageJson, /"verify:desktop-ipc-authorization"/)
assert.match(packageJson, /npm run verify:desktop-ipc-authorization/)

console.log('desktop IPC authorization verification passed')
