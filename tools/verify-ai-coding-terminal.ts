import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const handler = readFileSync('src/main/ipc/ai-coding-handlers.ts', 'utf8')
const dock = readFileSync('src/renderer/src/components/terminal/ProjectTerminalDock.tsx', 'utf8')
const store = readFileSync('src/renderer/src/stores/terminal-store.ts', 'utf8')

assert.match(handler, /execFileAsync\(cli, \['--version'\]/, 'CLI detection must bypass a shell')
assert.match(handler, /extraEnvironment: Record<string, string>/)
assert.match(handler, /createTerminalSession\([\s\S]*extraEnvironment/)
assert.doesNotMatch(handler, /command\s*=.*(?:apiKey|baseUrl|modelId)/)
assert.doesNotMatch(handler, /console\.(?:log|warn|error).*apiKey/)
assert.match(dock, /if \(sshConnectionId \|\| !workingFolder\) return/)
assert.match(dock, /!sshConnectionId &&[\s\S]*aiCodingConfigs\.map/)
assert.doesNotMatch(dock, /handleCreateTerminal\(['"](?:claude|codex|gemini)['"]\)/)
assert.match(store, /IPC\.AI_CODING_TERMINAL_LAUNCH/)
assert.doesNotMatch(store, /AI_CODING_TERMINAL_LAUNCH[\s\S]{0,500}TERMINAL_INPUT/)

console.log('AI coding terminal verification passed')
