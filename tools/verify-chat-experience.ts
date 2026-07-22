import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  preserveViewportOffsetAfterPrepend,
  shouldCompensateTranscriptRowResize
} from '../src/renderer/src/components/chat/chat-scroll-policy'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const anchored = preserveViewportOffsetAfterPrepend({
  previousScrollTop: 320,
  previousScrollHeight: 4000,
  nextScrollHeight: 12_000
})
assert(anchored === 8320, `prepend anchor moved: ${anchored}`)
assert(
  shouldCompensateTranscriptRowResize({
    itemEnd: 200,
    scrollOffset: 500,
    followingOutput: false
  }),
  'a resized row fully above the viewport should preserve the anchor'
)
assert(
  !shouldCompensateTranscriptRowResize({
    itemEnd: 700,
    scrollOffset: 500,
    followingOutput: false
  }),
  'an intersecting expanded row must not push the viewport'
)
assert(
  !shouldCompensateTranscriptRowResize({
    itemEnd: 200,
    scrollOffset: 500,
    followingOutput: true
  }),
  'the virtualizer must not compete with streaming bottom-follow'
)

const root = process.cwd()
const messageList = await readFile(
  path.join(root, 'src/renderer/src/components/chat/MessageList.tsx'),
  'utf8'
)
const collapsiblePanel = await readFile(
  path.join(root, 'src/renderer/src/components/chat/CollapsibleHeightPanel.tsx'),
  'utf8'
)
assert(messageList.includes('defaultRangeExtractor'), 'initial tail range optimization is missing')
assert(
  messageList.includes('DB_MESSAGES_LIST_MARKERS_MSGPACK_CHANNEL'),
  'message rail index is missing'
)
assert(messageList.includes("kind: 'streaming'"), 'streaming rail marker is missing')
assert(collapsiblePanel.includes('useReducedMotion'), 'reduced-motion handling is missing')

console.log('chat-experience verification passed')
