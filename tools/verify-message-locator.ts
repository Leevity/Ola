import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// Every assertion here is about code, not layout, so the source is read with whitespace
// collapsed. Collapsing turns a wrapped signature into `fn( arg: T ): R` and a wrapped
// object into `{ key: value, … }`, so patterns tolerate a space wherever the formatter
// may break a line. No assertion is line-anchored.
const source = await readCollapsedSource('src/renderer/src/components/chat/MessageList.tsx')

assert.match(source, /const ASSISTANT_RAIL_PREVIEW_LIMIT\s*=\s*120/)
assert.match(
  source,
  /function getAssistantVisibleText\(\s*content:\s*UnifiedMessage\['content'\]\s*\):\s*string/
)
assert.match(source, /function AssistantReplyRail\(/)
assert.match(source, /ASSISTANT_RAIL_DENSE_THRESHOLD\s*=\s*80/)
assert.match(source, /DB_MESSAGES_LIST_LOCATOR_MSGPACK_CHANNEL/)
assert.match(
  source,
  /loadMessageWindowAround\(\s*activeSessionId,\s*\{\s*messageId,\s*sortOrder:\s*target\.sortOrder\s*\},\s*30\s*\)/
)
assert.match(source, /messageIds:\s*string\[\s*\]/)
assert.match(source, /summary:\s*string/)
assert.match(
  source,
  /function appendAssistantRailSummary\(\s*current:\s*string,\s*next:\s*string\s*\):\s*string/
)
assert.match(
  source,
  /title:\s*previewItem\.preview,\s*detail:\s*previewItem\.summary\s*\|\|\s*null/
)
assert.match(source, /let activeTurn:\s*AssistantReplyRailItem\s*\|\s*null\s*=\s*null/)
assert.match(source, /activeTurn\.summary\s*=\s*appendAssistantRailSummary\(/)
assert.match(source, /itemIdByMessageId\.set\(\s*source\.id,\s*activeTurn\.id\s*\)/)
assert.match(source, /measuredMessageHeightsRef/)
assert.match(source, /getBoundingClientRect\(\)/)

console.log('assistant reply rail verification passed')
