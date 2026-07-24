import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile('src/renderer/src/components/chat/MessageList.tsx', 'utf8')

assert.match(source, /const ASSISTANT_RAIL_PREVIEW_LIMIT = 120/)
assert.match(
  source,
  /function getAssistantVisibleText\(content: UnifiedMessage\['content'\]\): string/
)
assert.match(source, /function AssistantReplyRail\(/)
assert.match(source, /ASSISTANT_RAIL_DENSE_THRESHOLD = 80/)
assert.match(source, /DB_MESSAGES_LIST_LOCATOR_MSGPACK_CHANNEL/)
assert.match(
  source,
  /loadMessageWindowAround\(activeSessionId, \{ messageId, sortOrder: target\.sortOrder \}, 30\)/
)
assert.match(source, /messageIds: string\[\]/)
assert.match(source, /summary: string/)
assert.match(source, /function appendAssistantRailSummary\(current: string, next: string\): string/)
assert.match(source, /title: previewItem\.preview, detail: previewItem\.summary \|\| null/)
assert.match(source, /let activeTurn: AssistantReplyRailItem \| null = null/)
assert.match(source, /activeTurn\.summary = appendAssistantRailSummary\(/)
assert.match(source, /itemIdByMessageId\.set\(source\.id, activeTurn\.id\)/)
assert.match(source, /measuredMessageHeightsRef/)
assert.match(source, /getBoundingClientRect\(\)/)

console.log('assistant reply rail verification passed')
