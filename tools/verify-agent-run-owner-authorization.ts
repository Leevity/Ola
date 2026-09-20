import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manager = await readFile('src/main/ipc/ts-runtime-handlers.ts', 'utf8')
const packageJson = await readFile('package.json', 'utf8')

assert.match(manager, /function trusted\(event: IpcMainInvokeEvent\): boolean/)
assert.match(manager, /event\.senderFrame === event\.sender\.mainFrame/)
assert.match(manager, /assertWindowWorkspace\(event, run\.workspaceId\)/)
assert.match(manager, /'ts-runtime:run-submit'/)
assert.match(manager, /'ts-runtime:run-snapshot'/)
assert.match(manager, /'ts-runtime:run-cancel'/)
assert.match(manager, /'ts-runtime:run-interact'/)
assert.match(manager, /workspaceId: run\.workspaceId[\s\S]*runId: run\.runId/)
assert.match(packageJson, /"verify:agent-run-owner-authorization"/)
assert.match(packageJson, /npm run verify:agent-run-owner-authorization/)

console.log('agent run owner authorization verification passed')
