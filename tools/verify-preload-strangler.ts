import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const preload = await readFile('src/preload/index.ts', 'utf8')
const preloadTypes = await readFile('src/preload/index.d.ts', 'utf8')
const ipcClient = await readFile('src/renderer/src/lib/ipc/ipc-client.ts', 'utf8')
const messagepackClient = await readFile(
  'src/renderer/src/lib/ipc/messagepack-ipc-client.ts',
  'utf8'
)
const streamReceiver = await readFile('src/renderer/src/lib/ipc/agent-stream-receiver.ts', 'utf8')
const rendererToolBridge = await readFile(
  'src/renderer/src/lib/ipc/renderer-tool-bridge.ts',
  'utf8'
)
const packageJson = await readFile('package.json', 'utf8')

assert.match(preload, /const olaIpc = \{/)
assert.match(preload, /contextBridge\.exposeInMainWorld\('ola', ola\)/)
assert.match(preloadTypes, /interface OlaIpcBridge/)
assert.match(preloadTypes, /ola: OlaBridge/)
assert.match(ipcClient, /window\.ola\?\.ipc/)
assert.doesNotMatch(ipcClient, /window\.electron\.ipcRenderer/)
assert.match(messagepackClient, /window\.ola\.ipc\.invoke/)
assert.doesNotMatch(messagepackClient, /window\.electron\.ipcRenderer/)
assert.match(streamReceiver, /window\.ola\.ipc\.on\(/)
assert.match(rendererToolBridge, /window\.ola\.ipc\.removeAllListeners/)
assert.match(rendererToolBridge, /window\.ola\.ipc\.on\(/)
assert.match(packageJson, /"verify:preload-strangler"/)
assert.match(packageJson, /npm run verify:preload-strangler/)

console.log('preload strangler verification passed')
