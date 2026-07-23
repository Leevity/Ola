import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manager = await readFile('src/main/ipc/sidecar-manager.ts', 'utf8')
const packageJson = await readFile('package.json', 'utf8')

assert.match(
  manager,
  /function isAgentRunOwnedBy\(\n\s{2}event: IpcMainInvokeEvent,\n\s{2}runId: string \| undefined,\n\s{2}runWindowIds: Map<string, number>\n\): runId is string/
)
assert.match(manager, /sourceWindow\.webContents === event\.sender/)
assert.match(manager, /runWindowIds\.get\(runId\) === sourceWindow\.id/)
assert.match(manager, /agent:run-snapshot'[\s\S]*isAgentRunOwnedBy\(event, runId, runWindowIds\)/)
assert.match(manager, /agent:cancel'[\s\S]*isAgentRunOwnedBy\(event, runId, runWindowIds\)/)
assert.match(manager, /agent:request-stop'[\s\S]*isAgentRunOwnedBy\(event, runId, runWindowIds\)/)
assert.match(
  manager,
  /agent:append-messages'[\s\S]*isAgentRunOwnedBy\(event, runId, runWindowIds\)/
)
assert.match(manager, /agent:cancel'[\s\S]*return \{ cancelled: false \}/)
assert.match(manager, /agent:request-stop'[\s\S]*return \{ stopped: false \}/)
assert.match(manager, /agent:append-messages'[\s\S]*return \{ appended: false, count: 0 \}/)
assert.match(packageJson, /"verify:agent-run-owner-authorization"/)
assert.match(packageJson, /npm run verify:agent-run-owner-authorization/)

console.log('agent run owner authorization verification passed')
