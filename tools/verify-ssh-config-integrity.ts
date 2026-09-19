import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const store = readFileSync('sidecars/Ola.Native.Worker/Modules/Ssh/SshConfigStore.cs', 'utf8')
const openSsh = readFileSync('sidecars/Ola.Native.Worker/Modules/Ssh/SshOpenSsh.cs', 'utf8')

assert.match(
  store,
  /throw new InvalidOperationException\("SSH config is corrupt; refusing to overwrite it", ex\)/
)
assert.doesNotMatch(store, /ssh config root read failed[\s\S]{0,180}return \[\];/)
assert.match(store, /File\.WriteAllText\(tempPath, root\.ToJsonString\(WriteOptions\)\)/)
assert.match(store, /File\.Move\(tempPath, filePath, true\)/)
assert.match(openSsh, /StrictHostKeyChecking=yes/)
assert.match(openSsh, /SSH multiplex directory cannot be a link/)
assert.match(openSsh, /File\.SetUnixFileMode\(/)
assert.match(
  openSsh,
  /UnixFileMode\.UserRead \| UnixFileMode\.UserWrite \| UnixFileMode\.UserExecute/
)

console.log('SSH config integrity verification passed')
