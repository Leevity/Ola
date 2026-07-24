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
const planReviewCard = await readFile(
  path.join(root, 'src/renderer/src/components/chat/PlanReviewCard.tsx'),
  'utf8'
)
const inputArea = await readFile(
  path.join(root, 'src/renderer/src/components/chat/InputArea.tsx'),
  'utf8'
)
const executionRunSummary = await readFile(
  path.join(root, 'src/renderer/src/components/chat/ExecutionRunSummary.tsx'),
  'utf8'
)
const subAgentCard = await readFile(
  path.join(root, 'src/renderer/src/components/chat/SubAgentCard.tsx'),
  'utf8'
)
assert(messageList.includes('defaultRangeExtractor'), 'initial tail range optimization is missing')
assert(
  messageList.includes('DB_MESSAGES_LIST_LOCATOR_MSGPACK_CHANNEL'),
  'assistant reply rail index is missing'
)
assert(
  messageList.includes("kind === 'streaming'") &&
    messageList.includes("activeTurn.kind = 'streaming'"),
  'streaming rail marker is missing'
)
assert(
  messageList.includes('countToolUseBlocks') &&
    messageList.includes("t('messageList.assistantRail.toolOnlyPreview'"),
  'tool-use locator summary is missing'
)
assert(collapsiblePanel.includes('useReducedMotion'), 'reduced-motion handling is missing')
assert(
  planReviewCard.includes('navigator.clipboard.writeText'),
  'plan markdown copy action is missing'
)
assert(planReviewCard.includes('URL.createObjectURL'), 'plan markdown download action is missing')
assert(planReviewCard.includes('openFilePreview'), 'plan source preview action is missing')
assert(
  inputArea.includes('data-file-suggestion-index'),
  'file suggestion selection marker is missing'
)
assert(
  inputArea.includes('data-slash-suggestion-index'),
  'slash suggestion selection marker is missing'
)
assert(
  inputArea.includes("scrollIntoView({ block: 'nearest', inline: 'nearest' })"),
  'suggestion auto-scroll is missing'
)
assert(
  inputArea.includes("openSettingsPage('permission')"),
  'permission whitelist settings shortcut is missing'
)
assert(
  inputArea.includes("['default', 'whitelist', 'full-access'] as const"),
  'full-access permission mode option is missing'
)
assert(
  inputArea.includes("t('permission.mode.fullAccessConfirmDescription')"),
  'full-access worker deny-rule explanation is missing'
)
assert(
  executionRunSummary.includes('function categorySummaries'),
  'execution category summary breakdown is missing'
)
assert(
  executionRunSummary.includes("run.status === 'failed' || run.status === 'pending-approval'"),
  'execution failure and approval indicators are missing'
)
assert(executionRunSummary.includes('categoryTags.map'), 'execution category tags are missing')
assert(subAgentCard.includes('{statusText}'), 'sub-agent persistent status is missing')
assert(subAgentCard.includes('{formatElapsed(elapsed)}'), 'sub-agent elapsed duration is missing')
assert(
  subAgentCard.includes('data-testid="sub-agent-cancel-button"'),
  'sub-agent cancellation control is missing'
)

console.log('chat-experience verification passed')
