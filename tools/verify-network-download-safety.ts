import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// Every assertion here is about tokens, not layout, so both sources are read with
// whitespace collapsed: a Biome re-wrap cannot turn this gate red. Collapsing leaves
// a space after `(` / `{` and before `)` / `}`, so each pattern tolerates `\s*`
// wherever the formatter may break a line. The asserted facts are unchanged.
const source = await readCollapsedSource('src/main/channels/providers/feishu/feishu-api.ts')
const channelHandlers = await readCollapsedSource('src/main/ipc/channel-handlers.ts')

// Each trailing literal needs a digit boundary: 3 prefixes 30 and 1024 prefixes 10240,
// so an unanchored cap only caught a lowered limit, never a raised one.
assert.match(source, /const MAX_DOWNLOAD_BYTES =\s*25\s*\*\s*1024\s*\*\s*1024(?![\d])/)
assert.match(source, /const MAX_DOWNLOAD_REDIRECTS =\s*3(?![\d])/)
assert.match(source, /url\.protocol\s*!==\s*'https:'/)
assert.ok(source.includes('url.username'))
assert.ok(source.includes('url.password'))
// The bracket-stripping regex is part of the SSRF guard: it must stay exactly this
// literal, only its surrounding whitespace is formatter-owned.
assert.match(source, /const hostname =\s*url\.hostname\.replace\(\s*\/\^\\\[\|\\\]\$\/g,\s*''\s*\)/)
assert.match(source, /resolvePublicAddress\(\s*hostname\s*\)/)
assert.match(source, /hostname:\s*endpoint\.address/)
assert.match(source, /servername:\s*hostname/)
assert.match(source, /redirects\s*\+\s*1/)
assert.match(source, /receivedBytes\s*>\s*MAX_DOWNLOAD_BYTES/)
assert.doesNotMatch(
  source,
  /const mod =\s*url\.startsWith\(\s*'https'\s*\)\s*\?\s*https\s*:\s*http/
)
assert.match(channelHandlers, /import \{\s*downloadSafeRemoteResource,\s*FeishuApi\s*\}/)
assert.match(channelHandlers, /buffer:\s*await downloadSafeRemoteResource\(\s*value\s*\)/)
assert.match(channelHandlers, /const buffer =\s*await downloadSafeRemoteResource\(\s*value\s*\)/)
assert.doesNotMatch(channelHandlers, /captureQrPageAsDataUrl/)
assert.doesNotMatch(channelHandlers, /await fetch\(\s*value\s*\)/)
assert.match(channelHandlers, /value\.length\s*>\s*4\s*\*\s*1024\s*\*\s*1024(?![\d])/)
assert.match(channelHandlers, /data:image\\\/\(\?:png\|jpeg\|gif\|webp\)/)

console.log('network download safety verification passed')
