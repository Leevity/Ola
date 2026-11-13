import {
  preserveViewportOffsetAfterPrepend,
  resolveChatAutoScrollState,
  shouldCompensateTranscriptRowResize
} from '../src/renderer/src/components/chat/chat-scroll-policy'
import { assertIncludes, assertMatch, readCollapsedSource } from './lib/source-text.ts'

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
  resolveChatAutoScrollState({
    mode: 'stream',
    distanceToBottom: 40,
    bottomThreshold: 80,
    previousOffset: 500,
    currentOffset: 490,
    correctionEpsilon: 2,
    isProgrammatic: false,
    isOutputting: true
  }).mode === 'off',
  'a deliberate upward scroll must pause streaming follow immediately'
)
assert(
  resolveChatAutoScrollState({
    mode: 'off',
    distanceToBottom: 0,
    bottomThreshold: 80,
    previousOffset: 490,
    currentOffset: 520,
    correctionEpsilon: 2,
    isProgrammatic: false,
    isOutputting: true
  }).mode === 'stream',
  'manual scrolling to the true bottom must resume streaming follow'
)
assert(
  resolveChatAutoScrollState({
    mode: 'off',
    distanceToBottom: 20,
    bottomThreshold: 80,
    previousOffset: 490,
    currentOffset: 520,
    correctionEpsilon: 2,
    isProgrammatic: false,
    isOutputting: true
  }).mode === 'off',
  'entering only the tolerance zone must not unexpectedly resume follow'
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

// Every text assertion below is about tokens, not layout, so the sources are read collapsed.
// Collapsing turns a wrapped call into `fn( arg )` and a wrapped array into `[ 'a', 'b' ]`,
// so each pattern tolerates a space wherever the formatter may break a line.
const messageList = await readCollapsedSource('src/renderer/src/components/chat/MessageList.tsx')
const collapsiblePanel = await readCollapsedSource(
  'src/renderer/src/components/chat/CollapsibleHeightPanel.tsx'
)
const viewportController = await readCollapsedSource(
  'src/renderer/src/components/chat/use-message-list-viewport.ts'
)
const viewportPrimitives = await readCollapsedSource(
  'src/renderer/src/components/chat/message-list-viewport.ts'
)
const planReviewCard = await readCollapsedSource(
  'src/renderer/src/components/chat/PlanReviewCard.tsx'
)
const inputArea = await readCollapsedSource('src/renderer/src/components/chat/InputArea.tsx')
const executionRunSummary = await readCollapsedSource(
  'src/renderer/src/components/chat/ExecutionRunSummary.tsx'
)
const subAgentCard = await readCollapsedSource('src/renderer/src/components/chat/SubAgentCard.tsx')
const assistantMessage = await readCollapsedSource(
  'src/renderer/src/components/chat/AssistantMessage.tsx'
)
const executionTraceCard = await readCollapsedSource(
  'src/renderer/src/components/chat/ExecutionTraceCard.tsx'
)
const finalOutcomeCard = await readCollapsedSource(
  'src/renderer/src/components/chat/FinalOutcomeCard.tsx'
)
const chatSendMessage = await readCollapsedSource('src/renderer/src/lib/agent/chat-send-message.ts')
const providerStore = await readCollapsedSource('src/renderer/src/stores/provider-store.ts')
const imageAttachments = await readCollapsedSource('src/renderer/src/lib/image-attachments.ts')
const presentationRegistry = await readCollapsedSource(
  'src/renderer/src/components/chat/tool-presentation-registry.ts'
)
assertIncludes(messageList, 'defaultRangeExtractor', 'initial tail range optimization is missing')
assertIncludes(
  messageList,
  'DB_MESSAGES_LIST_LOCATOR_MSGPACK_CHANNEL',
  'assistant reply rail index is missing'
)
assertMatch(messageList, /kind\s*===\s*'streaming'/, 'streaming rail marker is missing')
assertMatch(
  messageList,
  /activeTurn\s*\.\s*kind\s*=\s*'streaming'/,
  'streaming rail marker is missing'
)
assertIncludes(messageList, 'countToolUseBlocks', 'tool-use locator summary is missing')
assertMatch(
  messageList,
  /t\(\s*'messageList\.assistantRail\.toolOnlyPreview'/,
  'tool-use locator summary is missing'
)
assertIncludes(collapsiblePanel, 'useMotionProfile', 'reduced-motion handling is missing')
assertMatch(
  collapsiblePanel,
  /enabled\s*&&\s*profile\s*\.\s*transform/,
  'reduced-motion handling is missing'
)
assertMatch(
  collapsiblePanel,
  /new\s+ResizeObserver\(\s*measure\s*\)/,
  'dynamic height observer is missing'
)
assertMatch(
  collapsiblePanel,
  /height:\s*canAnimate\s*\?\s*contentHeight\s*:\s*'auto'/,
  'dynamic content height is not connected to the transition'
)
assertMatch(
  collapsiblePanel,
  /EXECUTION_RESIZE_EVENT\s*=\s*'ola:execution-resize'/,
  'execution collapse must notify the virtual transcript and support scroll-up motion'
)
assertIncludes(
  collapsiblePanel,
  'notifyExecutionResize',
  'execution collapse must notify the virtual transcript and support scroll-up motion'
)
assertMatch(
  collapsiblePanel,
  /collapseMotion\?:\s*'clip'\s*\|\s*'scroll-up'/,
  'execution collapse must notify the virtual transcript and support scroll-up motion'
)
assertIncludes(
  viewportController,
  'MessageWindowPhase',
  'message viewport controller is missing lifecycle and history-load policy'
)
assertIncludes(
  viewportController,
  "'positioning'",
  'message viewport controller is missing lifecycle and history-load policy'
)
assertIncludes(
  viewportController,
  'requestOlderLoad',
  'message viewport controller is missing lifecycle and history-load policy'
)
assertIncludes(
  viewportPrimitives,
  'getMessageAnchorCorrection',
  'message viewport anchor and fill safeguards are missing'
)
assertIncludes(
  viewportPrimitives,
  'historyCorrectFrames',
  'message viewport anchor and fill safeguards are missing'
)
assertIncludes(
  viewportPrimitives,
  'maxFillPages',
  'message viewport anchor and fill safeguards are missing'
)
assertMatch(
  messageList,
  /getMessageAnchorCorrection\(\s*nextRef,\s*anchor\s*\)/,
  'message list must correct anchors and remeasure after execution collapse'
)
assertIncludes(
  messageList,
  'EXECUTION_RESIZE_EVENT',
  'message list must correct anchors and remeasure after execution collapse'
)
assertMatch(
  messageList,
  /rowVirtualizer\s*\.\s*measure\(\s*\)/,
  'message list must correct anchors and remeasure after execution collapse'
)
assertMatch(
  planReviewCard,
  /navigator\s*\.\s*clipboard\s*\.\s*writeText/,
  'plan markdown copy action is missing'
)
assertMatch(
  planReviewCard,
  /URL\s*\.\s*createObjectURL/,
  'plan markdown download action is missing'
)
assertIncludes(planReviewCard, 'openFilePreview', 'plan source preview action is missing')
assertMatch(
  planReviewCard,
  /<ModelSwitcher\s+sessionId=\{\s*planExecutionSessionId\s*\}\s*\/>/,
  'plan execution must expose a session-scoped model choice and use the plan run state'
)
assertIncludes(
  planReviewCard,
  'hasStreamingExecutionMessage',
  'plan execution must expose a session-scoped model choice and use the plan run state'
)
assertIncludes(
  inputArea,
  'data-file-suggestion-index',
  'file suggestion selection marker is missing'
)
assertIncludes(
  inputArea,
  'data-slash-suggestion-index',
  'slash suggestion selection marker is missing'
)
assertMatch(
  inputArea,
  /scrollIntoView\(\s*\{\s*block:\s*'nearest',\s*inline:\s*'nearest'\s*\}\s*\)/,
  'suggestion auto-scroll is missing'
)
assertMatch(
  inputArea,
  /openSettingsPage\(\s*'permission'\s*\)/,
  'permission whitelist settings shortcut is missing'
)
assertMatch(
  inputArea,
  /\[\s*'default',\s*'whitelist',\s*'full-access'\s*\]\s*as\s+const/,
  'full-access permission mode option is missing'
)
assertMatch(
  inputArea,
  /t\(\s*'permission\.mode\.fullAccessConfirmDescription'\s*\)/,
  'full-access worker deny-rule explanation is missing'
)
assertMatch(
  executionRunSummary,
  /function\s+categorySummaries/,
  'execution category summary breakdown is missing'
)
assertMatch(
  executionRunSummary,
  /run\s*\.\s*status\s*===\s*'failed'\s*\|\|\s*run\s*\.\s*status\s*===\s*'pending-approval'/,
  'execution failure and approval indicators are missing'
)
assertMatch(executionRunSummary, /categoryTags\s*\.\s*map/, 'execution category tags are missing')
assertMatch(subAgentCard, /\{\s*statusText\s*\}/, 'sub-agent persistent status is missing')
assertMatch(
  subAgentCard,
  /\{\s*formatElapsed\(\s*elapsed\s*\)\s*\}/,
  'sub-agent elapsed duration is missing'
)
assertIncludes(
  subAgentCard,
  'data-testid="sub-agent-cancel-button"',
  'sub-agent cancellation control is missing'
)
assertIncludes(
  assistantMessage,
  '<ExecutionTraceCard',
  'result-first two-layer outcome rendering is missing'
)
assertMatch(
  assistantMessage,
  /<FinalOutcomeCard\s+outcome=\{\s*runOutcome\s*\.\s*outcome\s*\}/,
  'result-first two-layer outcome rendering is missing'
)
assertIncludes(
  executionTraceCard,
  'type="button"',
  'completed execution trace must provide a keyboard-accessible process navigation action'
)
assertMatch(
  executionTraceCard,
  /onClick=\{\s*onViewProcess\s*\}/,
  'completed execution trace must provide a keyboard-accessible process navigation action'
)
assertMatch(
  assistantMessage,
  /onViewProcess=\{\s*expandExecutionRuns\s*\}/,
  'completed execution trace must provide a keyboard-accessible process navigation action'
)
assertMatch(
  finalOutcomeCard,
  /React\s*\.\s*useId\(\s*\)/,
  'final outcome heading ids must be unique'
)
assertMatch(
  presentationRegistry,
  /class\s+ToolPresentationRegistry/,
  'tool presentation registry adapters are incomplete'
)
assertMatch(
  presentationRegistry,
  /adapter\(\s*'project-intelligence'/,
  'tool presentation registry adapters are incomplete'
)
assertMatch(
  presentationRegistry,
  /adapter\(\s*'mcp-extension'/,
  'tool presentation registry adapters are incomplete'
)
assertMatch(
  chatSendMessage,
  /modelExplicitlyRejectsVision\(\s*healthyProvider\s*\.\s*modelConfig/,
  'image input must be rejected before a text-only model receives it and preserved for vision models'
)
assertMatch(
  chatSendMessage,
  /throw\s+new\s+VisionInputUnsupportedError\(\s*\)/,
  'image input must be rejected before a text-only model receives it and preserved for vision models'
)
assertMatch(
  chatSendMessage,
  /content:\s*buildUserMessageContent\(\s*textForUserBlock,\s*images,\s*textBlocks\s*\)/,
  'image input must be rejected before a text-only model receives it and preserved for vision models'
)
assertMatch(
  providerStore,
  /export\s+function\s+modelExplicitlyRejectsVision/,
  'only explicitly text-only models may block image input'
)
assertMatch(
  providerStore,
  /return\s+model\s*\.\s*supportsVision\s*===\s*false/,
  'only explicitly text-only models may block image input'
)
assertIncludes(
  inputArea,
  'shouldRejectSelectedModelVisionInput',
  'rejected image sends must stay in the home composer or restore the attachment without a duplicate generic error'
)
assertMatch(
  inputArea,
  /isVisionInputUnsupportedError\(\s*error\s*\)/,
  'rejected image sends must stay in the home composer or restore the attachment without a duplicate generic error'
)
assertMatch(
  inputArea,
  /setAttachedImages\(\s*cloneImageAttachments\(\s*submittedDraft\s*\.\s*images\s*\)\s*\)/,
  'rejected image sends must stay in the home composer or restore the attachment without a duplicate generic error'
)
assertMatch(
  imageAttachments,
  /export\s+class\s+VisionInputUnsupportedError/,
  'vision input rejection needs a typed send error'
)

console.log('chat-experience verification passed')
