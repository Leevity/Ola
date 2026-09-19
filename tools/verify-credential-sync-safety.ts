import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [vault, syncStore] = await Promise.all([
  readFile('src/main/credentials/secret-vault.ts', 'utf8'),
  readFile('sidecars/Ola.Native.Worker/Modules/Sync/SyncFileStore.cs', 'utf8')
])

assert.match(vault, /mkdirSync\(dir, \{ recursive: true, mode: 0o700 \}\)/)
assert.match(vault, /chmodSync\(dir, 0o700\)/)
assert.match(vault, /backend !== 'basic_text'/)
assert.match(syncStore, /DataFileIncludes = \["settings\.json"\]/)
assert.match(syncStore, /RemoveSensitiveValues\(settingsRoot\)/)
assert.match(
  syncStore,
  /PreserveLocalSensitiveValues\(settingsRoot, SettingsStore\.ReadRootSnapshot\(\)\)/
)
assert.match(syncStore, /"bearertoken"/)
assert.match(syncStore, /"sessiontoken"/)
assert.match(syncStore, /"idtoken"/)

console.log('credential and sync safety verification passed')
