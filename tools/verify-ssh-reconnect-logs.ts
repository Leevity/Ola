import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const handler = readFileSync('src/main/ipc/ssh-handlers.ts', 'utf8')
const contract = readFileSync('src/shared/ssh-contract.ts', 'utf8')

assert.match(contract, /'reconnecting'/)
assert.match(handler, /MAX_SSH_DIAGNOSTIC_ENTRIES = 500/)
assert.match(
  handler,
  /sshDiagnostics\.splice\(0, sshDiagnostics\.length - MAX_SSH_DIAGNOSTIC_ENTRIES\)/
)
assert.match(handler, /if \(session\.userInitiatedDisconnect \|\| session\.reconnectTimer\) return/)
assert.match(
  handler,
  /session\.userInitiatedDisconnect = true[\s\S]*clearTimeout\(session\.reconnectTimer\)/
)
assert.match(handler, /password\|passphrase\|token\|private\[_ -\]\?key/)
assert.doesNotMatch(handler, /recordSshDiagnostic\([^)]*(?:password|passphrase|privateKey|token)/i)
assert.match(handler, /'ssh:diagnostics:list'/)

console.log('SSH reconnect and diagnostics verification passed')
