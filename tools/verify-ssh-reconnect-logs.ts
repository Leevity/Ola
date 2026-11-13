import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// These are behavioural invariants expressed over code, not layout, so both sources are
// read collapsed. Patterns tolerate a space wherever the formatter may break a line.
// The redaction pattern is matched verbatim: it is the text of a regex literal, which the
// formatter never re-wraps, so adding tolerance there would change what is asserted.
const handler = await readCollapsedSource('src/main/ipc/ssh-handlers.ts')
const contract = await readCollapsedSource('src/shared/ssh-contract.ts')

assert.match(contract, /'reconnecting'/)
// 500 prefixes 5000, so an unanchored literal only caught a lowered cap, never a raised one.
assert.match(handler, /MAX_SSH_DIAGNOSTIC_ENTRIES\s*=\s*500(?![\d])/)
assert.match(
  handler,
  /sshDiagnostics\s*\.\s*splice\(\s*0,\s*sshDiagnostics\s*\.\s*length\s*-\s*MAX_SSH_DIAGNOSTIC_ENTRIES\s*\)/
)
assert.match(
  handler,
  /if\s*\(\s*session\s*\.\s*userInitiatedDisconnect\s*\|\|\s*session\s*\.\s*reconnectTimer\s*\)\s*return/
)
// Four sites set userInitiatedDisconnect before clearing the reconnect timer, so a
// file-global ordering pattern never proved the ssh:disconnect handler does it. Bound the
// handler by the next registration rather than letting [\s\S]* borrow a neighbour.
const boundaries = [
  ...handler.matchAll(/registerSshMessagePackHandler|ipcMain\s*\.\s*on\(\s*toMessagePackChannel\(/g)
].map((match) => match.index as number)
const handlerWindow = (channel: string): string => {
  const start = handler.indexOf(`'${channel}'`)
  if (start < 0) throw new Error(`Missing ${channel} handler`)
  const owner = boundaries.filter((index) => index <= start).at(-1)
  const next = boundaries.find((index) => index > start)
  return handler.slice(owner ?? start, next ?? handler.length)
}
assert.match(
  handlerWindow('ssh:disconnect'),
  /session\s*\.\s*userInitiatedDisconnect\s*=\s*true[\s\S]*clearTimeout\(\s*session\s*\.\s*reconnectTimer\s*\)/,
  'ssh:disconnect must mark the disconnect before clearing the reconnect timer'
)
assert.match(handler, /password\|passphrase\|token\|private\[_ -\]\?key/)
// Negative assertion: no diagnostic call may carry a secret. Collapsing keeps this at
// least as strict, because a wrapped argument list is now visible to `[^)]*` too.
assert.doesNotMatch(handler, /recordSshDiagnostic\([^)]*(?:password|passphrase|privateKey|token)/i)
assert.match(handler, /'ssh:diagnostics:list'/)

console.log('SSH reconnect and diagnostics verification passed')
