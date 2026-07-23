import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const store = readFileSync('sidecars/Ola.Native.Worker/Modules/Ssh/SshConfigStore.cs', 'utf8')

assert.match(
  store,
  /throw new InvalidOperationException\("SSH config is corrupt; refusing to overwrite it", ex\)/
)
assert.doesNotMatch(store, /ssh config root read failed[\s\S]{0,180}return \[\];/)
assert.match(store, /File\.WriteAllText\(tempPath, root\.ToJsonString\(WriteOptions\)\)/)
assert.match(store, /File\.Move\(tempPath, filePath, true\)/)

console.log('SSH config integrity verification passed')
