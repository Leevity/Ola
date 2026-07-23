import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile('src/renderer/src/components/chat/MessageList.tsx', 'utf8')

assert.match(source, /const USER_LOCATOR_PREVIEW_LIMIT = 88/)
assert.match(
  source,
  /function getMessageLocatorText\(content: UnifiedMessage\['content'\]\): string/
)
assert.match(source, /isSystemPromptText\(content\) \? '' : content/)
assert.match(source, /block\.type === 'tool_use'/)
assert.match(source, /toolNames\.slice\(0, 3\)/)
assert.match(source, /Tool: \$\{toolNames/)
assert.match(source, /block\.type === 'tool_result'/)
assert.match(source, /failedToolResultCount/)
assert.match(source, /Tool result:/)
assert.match(source, /truncateLocatorPreview\(/)
assert.match(source, /DB_MESSAGES_LIST_MARKERS_MSGPACK_CHANNEL/)
assert.match(
  source,
  /loadMessageWindowAround\(activeSessionId, \{ messageId, sortOrder: item\.sortOrder \}, 30\)/
)
assert.match(source, /<UserMessageLocator/)

console.log('message locator verification passed')
