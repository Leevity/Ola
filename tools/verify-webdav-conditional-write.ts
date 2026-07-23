import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/main/sync/webdav-provider.ts', 'utf8')

assert.match(source, /function buildConditionalUploadHeaders\(/)
assert.match(source, /'If-None-Match': '\*'/)
assert.match(source, /'If-Match': `"\$\{options\.previousEtag\}"`/)
assert.match(source, /\.\.\.buildConditionalUploadHeaders\(options\)/)
assert.match(source, /if \(response\.status === 412\) throw new RemoteStateChangedError\(\)/)

console.log('webdav conditional write verification passed')
