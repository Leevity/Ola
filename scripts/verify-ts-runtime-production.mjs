import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
const scripts = packageJson.scripts ?? {}
assert.equal(
  scripts['native:publish'],
  undefined,
  'native:publish must not be a production command'
)
assert.equal(
  scripts['package:prepare:legacy'],
  undefined,
  'legacy package preparation must be removed'
)

const sources = await Promise.all(
  [
    'scripts/predev.mjs',
    'src/main/index.ts',
    'src/renderer/src/lib/ipc/agent-bridge.ts',
    'src/renderer/src/hooks/use-chat-actions.ts',
    'src/renderer/src/lib/agent/final-outcome.ts',
    'src/main/ipc/channel-handlers.ts',
    'src/renderer/src/App.tsx',
    'src/renderer/src/lib/agent/runtime-reattach.ts',
    'src/renderer/src/lib/ipc/agent-bridge.ts'
  ].map(async (file) => [file, await readFile(file, 'utf8')])
)
for (const [file, source] of sources) {
  assert.equal(
    source.includes('OLA_ENABLE_LEGACY_NATIVE_WORKERS'),
    false,
    `${file} must not expose a legacy Native Worker switch`
  )
}
const main = sources.find(([file]) => file === 'src/main/index.ts')[1]
assert.equal(
  main.includes('registerSidecarHandlers'),
  false,
  'production Main must not register sidecar IPC'
)
assert.equal(
  main.includes("from './lib/native-worker'"),
  false,
  'production Main must not own Native Worker lifecycle'
)

const manifest = JSON.parse(await readFile('src/shared/worker-assets.json', 'utf8'))
assert.equal(
  manifest.assets.some((asset) => asset.id === 'native-worker'),
  false,
  'production worker manifest must not require Native Worker'
)
const rendererBridge = sources.find(
  ([file]) => file === 'src/renderer/src/lib/ipc/agent-bridge.ts'
)[1]
assert.equal(
  rendererBridge.includes("ipcClient.invoke('sidecar:can-handle'"),
  false,
  'production Renderer must not probe removed sidecar capability IPC'
)
assert.match(
  rendererBridge,
  /TS_RUNTIME_TEXT_REQUIRED/,
  'auxiliary text requests must fail through the TS runtime boundary'
)
const chatActions = sources.find(
  ([file]) => file === 'src/renderer/src/hooks/use-chat-actions.ts'
)[1]
assert.equal(
  chatActions.includes('streamSidecarProviderTurn'),
  false,
  'production Chat must not invoke the removed sidecar provider turn'
)
const channelHandlers = sources.find(([file]) => file === 'src/main/ipc/channel-handlers.ts')[1]
assert.doesNotMatch(
  channelHandlers,
  /requestNativeDb|canary(?:List|Find)PluginSession/,
  'production channel IPC must not retain a Native DB or legacy-read fallback'
)
assert.doesNotMatch(
  channelHandlers,
  /TS_RUNTIME_DB_ROUTE_REMOVED/,
  'production channel IPC must not use the removed DB route'
)
for (const file of [
  'src/renderer/src/App.tsx',
  'src/renderer/src/lib/agent/runtime-reattach.ts',
  'src/renderer/src/lib/ipc/agent-bridge.ts'
]) {
  const source = sources.find(([candidate]) => candidate === file)[1]
  assert.doesNotMatch(
    source,
    /reattachActiveAgentRuns|agent-stream-receiver|sessionSidecarRunIds|readSidecarDebugBody|Sidecar unavailable/,
    `${file} must not retain the removed Agent/Sidecar runtime path`
  )
}
console.log('TS runtime production boundary verification passed')
