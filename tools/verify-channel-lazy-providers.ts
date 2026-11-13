import assert from 'node:assert/strict'
import { readCollapsedSource, readSource } from './lib/source-text.ts'

// The static-import ban is genuinely line-anchored (`^import …` per line), so it keeps
// reading the raw source. Every other assertion is about tokens, so those reads collapse
// whitespace and tolerate a break wherever the formatter may wrap one.
const indexRaw = await readSource('src/main/index.ts')
const index = await readCollapsedSource('src/main/index.ts')
const manager = await readCollapsedSource('src/main/channels/channel-manager.ts')
const types = await readCollapsedSource('src/main/channels/channel-types.ts')

assert.doesNotMatch(indexRaw, /^import .*channels\/providers\//m)
assert.match(index, /await import\(\s*'\.\/channels\/providers\/telegram\/telegram-service'\s*\)/)
assert.match(index, /await import\(\s*'\.\/channels\/providers\/feishu\/feishu-api'\s*\)/)
assert.match(index, /registerParserLoader\(/)
assert.match(types, /Promise<\s*MessagingChannelService\s*>/)
assert.match(types, /ChannelWsMessageParserLoader/)
assert.match(manager, /const service = await factory\(\s*instance,\s*\(event\) =>/)
assert.match(
  manager,
  /if \(\s*this\s*\.\s*shouldNotify\(\s*event\s*\)\s*\)\s*notify\(\s*event\s*\)/
)
assert.match(
  manager,
  /await this\s*\.\s*parserLoaders\s*\.\s*get\(\s*instance\s*\.\s*type\s*\)\s*\?\s*\.\s*\(\s*\)/
)
assert.match(
  manager,
  /if \(\s*parser\s*\)\s*this\s*\.\s*parsers\s*\.\s*set\(\s*instance\s*\.\s*type,\s*parser\s*\)/
)

console.log('channel lazy provider verification passed')
