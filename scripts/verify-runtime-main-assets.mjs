import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const assets = [
  'out/main/journal-worker.mjs',
  'out/main/journal-schema.mjs',
  'out/main/business-worker.mjs',
  'out/main/business-schema.mjs',
  'out/main/graph-store-worker.mjs',
  'out/storage/lease-worker.mjs'
]

await execute(process.execPath, ['scripts/build-ts-runtime.mjs'])
await Promise.all(assets.map((asset) => access(asset)))

const launchScript = await readFile('scripts/launch-dev.mjs', 'utf8')
assert.match(launchScript, /scripts\/build-ts-runtime\.mjs/)
assert.match(launchScript, /Failed to prepare TS runtime worker assets/)

const journal = await readFile('src/runtime/storage/run-journal.ts', 'utf8')
assert.match(journal, /defaultApp/)
assert.match(journal, /\.\.\/\.\.\/src\/runtime\/storage\/journal-worker\.mjs/)

const packaging = await readFile('electron-builder.yml', 'utf8')
assert.doesNotMatch(packaging, /legacy-read-worker\.mjs/)
assert.match(packaging, /out\/storage\/lease-worker\.mjs/)

const bridge = await readFile('src/renderer/src/lib/ipc/ts-runtime-bridge.ts', 'utf8')
assert.match(bridge, /return `ts-runtime:\$\{name\}:msgpack`/)
assert.doesNotMatch(bridge, /messagepack:ts-runtime/)

const main = await readFile('src/main/index.ts', 'utf8')
assert.ok(
  main.indexOf('registerTsRuntimeHandlers()') < main.indexOf("'create_main_window', createWindow"),
  'TS Runtime handlers must be registered before the first renderer window'
)
assert.ok(
  main.indexOf('registerConfigHandlers()') < main.indexOf("'create_main_window', createWindow"),
  'config handlers must be registered before the first renderer window'
)
assert.ok(
  main.indexOf('registerSettingsHandlers()') < main.indexOf("'create_main_window', createWindow"),
  'settings handlers must be registered before the first renderer window'
)

console.log('TS runtime Main worker assets verification passed')
