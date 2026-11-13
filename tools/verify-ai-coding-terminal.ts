import assert from 'node:assert/strict'
import { readCollapsedSource, readSource } from './lib/source-text.ts'

// Token-level assertions read collapsed sources so a Biome re-wrap cannot turn this gate red.
// Collapsing turns a wrapped call into `fn( arg )`, so patterns tolerate a space wherever the
// formatter may break a line.
const handler = await readCollapsedSource('src/main/ipc/ai-coding-handlers.ts')
const dock = await readCollapsedSource(
  'src/renderer/src/components/terminal/ProjectTerminalDock.tsx'
)
const store = await readCollapsedSource('src/renderer/src/stores/terminal-store.ts')

// These three negatives are scoped by design: `.` stops at a newline and `{0,500}` is a raw
// character window. Collapsing would widen both to the whole file and change what they forbid,
// so they keep the raw source and their original line/window scope.
const handlerRaw = await readSource('src/main/ipc/ai-coding-handlers.ts')
const storeRaw = await readSource('src/renderer/src/stores/terminal-store.ts')

assert.match(
  handler,
  /function\s+isTrustedAiCodingIpcSender\(\s*event:\s*IpcMainInvokeEvent\s*\):\s*boolean/
)
assert.match(handler, /ownerWindow\s*\.\s*webContents\s*===\s*event\s*\.\s*sender/)
assert.match(handler, /event\s*\.\s*senderFrame\s*===\s*event\s*\.\s*sender\s*\.\s*mainFrame/)
assert.match(handler, /ai-coding:terminal-launch'[\s\S]*isTrustedAiCodingIpcSender\(\s*event\s*\)/)
assert.match(handler, /Unauthorized AI coding IPC sender/)
assert.match(
  handler,
  /execFileAsync\(\s*cli,\s*\[\s*'--version'\s*\]/,
  'CLI detection must bypass a shell'
)
assert.match(handler, /extraEnvironment:\s*Record<\s*string,\s*string\s*>/)
assert.match(handler, /createTerminalSession\([\s\S]*extraEnvironment/)
assert.doesNotMatch(handlerRaw, /command\s*=.*(?:apiKey|baseUrl|modelId)/)
assert.doesNotMatch(handlerRaw, /console\.(?:log|warn|error).*apiKey/)
assert.match(dock, /if\s*\(\s*sshConnectionId\s*\|\|\s*!workingFolder\s*\)\s*return/)
// The guard must sit immediately before the config list it protects. `!sshConnectionId &&`
// occurs at five unrelated sites, so an unbounded window let the earliest one vouch for this
// render: deleting the guard here stayed green. Adjacency pins it to the actual site.
assert.match(dock, /!sshConnectionId\s*&&\s*aiCodingConfigs\s*\.\s*map/)
assert.doesNotMatch(dock, /handleCreateTerminal\(\s*['"](?:claude|codex|gemini)['"]\s*\)/)
assert.match(store, /IPC\s*\.\s*AI_CODING_TERMINAL_LAUNCH/)
assert.doesNotMatch(storeRaw, /AI_CODING_TERMINAL_LAUNCH[\s\S]{0,500}TERMINAL_INPUT/)

console.log('AI coding terminal verification passed')
