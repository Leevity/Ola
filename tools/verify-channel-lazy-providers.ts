import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const index = readFileSync('src/main/index.ts', 'utf8')
const manager = readFileSync('src/main/channels/channel-manager.ts', 'utf8')
const types = readFileSync('src/main/channels/channel-types.ts', 'utf8')

assert.doesNotMatch(index, /^import .*channels\/providers\//m)
assert.match(index, /await import\('\.\/channels\/providers\/telegram\/telegram-service'\)/)
assert.match(index, /await import\('\.\/channels\/providers\/feishu\/feishu-api'\)/)
assert.match(index, /registerParserLoader\(/)
assert.match(types, /Promise<MessagingChannelService>/)
assert.match(types, /ChannelWsMessageParserLoader/)
assert.match(manager, /const service = await factory\(instance, \(event\) =>/)
assert.match(manager, /if \(this\.shouldNotify\(event\)\) notify\(event\)/)
assert.match(manager, /await this\.parserLoaders\.get\(instance\.type\)\?\.\(\)/)
assert.match(manager, /if \(parser\) this\.parsers\.set\(instance\.type, parser\)/)

console.log('channel lazy provider verification passed')
