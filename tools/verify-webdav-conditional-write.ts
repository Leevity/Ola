import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// Conditional-write semantics are a data-safety invariant: the assertions below keep
// their exact meaning and only lose their dependence on layout. The source is read
// with whitespace collapsed, and each pattern tolerates `\s*` where Biome may wrap a
// call, an object member or a single-line `if`.
const source = await readCollapsedSource('src/main/sync/webdav-provider.ts')

assert.match(source, /function buildConditionalUploadHeaders\(/)
assert.match(source, /'If-None-Match':\s*'\*'/)
assert.match(source, /'If-Match':\s*`"\$\{options\.previousEtag\}"`/)
assert.match(source, /\.\.\.buildConditionalUploadHeaders\(\s*options\s*\)/)
assert.match(
  source,
  /if \(\s*response\.status\s*===\s*412\s*\)\s*throw new RemoteStateChangedError\(\s*\)/
)

console.log('webdav conditional write verification passed')
