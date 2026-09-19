import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile('src/main/channels/providers/feishu/feishu-api.ts', 'utf8')
const channelHandlers = await readFile('src/main/ipc/channel-handlers.ts', 'utf8')

assert.match(source, /const MAX_DOWNLOAD_BYTES = 25 \* 1024 \* 1024/)
assert.match(source, /const MAX_DOWNLOAD_REDIRECTS = 3/)
assert.match(source, /url\.protocol !== 'https:'/)
assert.ok(source.includes('url.username'))
assert.ok(source.includes('url.password'))
assert.ok(source.includes("const hostname = url.hostname.replace(/^\\[|\\]$/g, '')"))
assert.match(source, /resolvePublicAddress\(hostname\)/)
assert.match(source, /hostname: endpoint\.address/)
assert.match(source, /servername: hostname/)
assert.match(source, /redirects \+ 1/)
assert.match(source, /receivedBytes > MAX_DOWNLOAD_BYTES/)
assert.doesNotMatch(source, /const mod = url\.startsWith\('https'\) \? https : http/)
assert.match(channelHandlers, /import \{ downloadSafeRemoteResource, FeishuApi \}/)
assert.match(channelHandlers, /buffer: await downloadSafeRemoteResource\(value\)/)
assert.match(channelHandlers, /const buffer = await downloadSafeRemoteResource\(value\)/)
assert.doesNotMatch(channelHandlers, /captureQrPageAsDataUrl/)
assert.doesNotMatch(channelHandlers, /await fetch\(value\)/)
assert.match(channelHandlers, /value\.length > 4 \* 1024 \* 1024/)
assert.match(channelHandlers, /data:image\\\/\(\?:png\|jpeg\|gif\|webp\)/)

console.log('network download safety verification passed')
