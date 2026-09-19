import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  preserveViewportOffsetAfterPrepend,
  resolveChatAutoScrollState,
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

const root = process.cwd()
const messageList = await readFile(
  path.join(root, 'src/renderer/src/components/chat/MessageList.tsx'),
  'utf8'
)
const collapsiblePanel = await readFile(
  path.join(root, 'src/renderer/src/components/chat/CollapsibleHeightPanel.tsx'),
  'utf8'
)
const viewportController = await readFile(
  path.join(root, 'src/renderer/src/components/chat/use-message-list-viewport.ts'),
  'utf8'
)
const viewportPrimitives = await readFile(
  path.join(root, 'src/renderer/src/components/chat/message-list-viewport.ts'),
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
const assistantMessage = await readFile(
  path.join(root, 'src/renderer/src/components/chat/AssistantMessage.tsx'),
  'utf8'
)
const executionTraceCard = await readFile(
  path.join(root, 'src/renderer/src/components/chat/ExecutionTraceCard.tsx'),
  'utf8'
)
const finalOutcomeCard = await readFile(
  path.join(root, 'src/renderer/src/components/chat/FinalOutcomeCard.tsx'),
  'utf8'
)
const chatActions = await readFile(
  path.join(root, 'src/renderer/src/hooks/use-chat-actions.ts'),
  'utf8'
)
const providerStore = await readFile(
  path.join(root, 'src/renderer/src/stores/provider-store.ts'),
  'utf8'
)
const imageAttachments = await readFile(
  path.join(root, 'src/renderer/src/lib/image-attachments.ts'),
  'utf8'
)
const presentationRegistry = await readFile(
  path.join(root, 'src/renderer/src/components/chat/tool-presentation-registry.ts'),
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
  collapsiblePanel.includes('new ResizeObserver(measure)'),
  'dynamic height observer is missing'
)
assert(
  collapsiblePanel.includes("height: canAnimate ? contentHeight : 'auto'"),
  'dynamic content height is not connected to the transition'
)
assert(
  collapsiblePanel.includes("EXECUTION_RESIZE_EVENT = 'ola:execution-resize'") &&
    collapsiblePanel.includes('notifyExecutionResize') &&
    collapsiblePanel.includes("collapseMotion?: 'clip' | 'scroll-up'"),
  'execution collapse must notify the virtual transcript and support scroll-up motion'
)
assert(
  viewportController.includes('MessageWindowPhase') &&
    viewportController.includes("'positioning'") &&
    viewportController.includes('requestOlderLoad'),
  'message viewport controller is missing lifecycle and history-load policy'
)
assert(
  viewportPrimitives.includes('getMessageAnchorCorrection') &&
    viewportPrimitives.includes('historyCorrectFrames') &&
    viewportPrimitives.includes('maxFillPages'),
  'message viewport anchor and fill safeguards are missing'
)
assert(
  messageList.includes('getMessageAnchorCorrection(nextRef, anchor)') &&
    messageList.includes('EXECUTION_RESIZE_EVENT') &&
    messageList.includes('rowVirtualizer.measure()'),
  'message list must correct anchors and remeasure after execution collapse'
)
assert(
  planReviewCard.includes('navigator.clipboard.writeText'),
  'plan markdown copy action is missing'
)
assert(planReviewCard.includes('URL.createObjectURL'), 'plan markdown download action is missing')
assert(planReviewCard.includes('openFilePreview'), 'plan source preview action is missing')
assert(
  planReviewCard.includes('<ModelSwitcher sessionId={planExecutionSessionId} />') &&
    planReviewCard.includes('hasStreamingExecutionMessage'),
  'plan execution must expose a session-scoped model choice and use the plan run state'
)
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
assert(
  assistantMessage.includes('<ExecutionTraceCard') &&
    assistantMessage.includes('<FinalOutcomeCard outcome={runOutcome.outcome}'),
  'result-first two-layer outcome rendering is missing'
)
assert(
  executionTraceCard.includes('type="button"') &&
    executionTraceCard.includes('onClick={onViewProcess}') &&
    assistantMessage.includes('onViewProcess={expandExecutionRuns}'),
  'completed execution trace must provide a keyboard-accessible process navigation action'
)
assert(finalOutcomeCard.includes('React.useId()'), 'final outcome heading ids must be unique')
assert(
  presentationRegistry.includes('class ToolPresentationRegistry') &&
    presentationRegistry.includes("adapter('project-intelligence'") &&
    presentationRegistry.includes("adapter('mcp-extension'"),
  'tool presentation registry adapters are incomplete'
)
assert(
  chatActions.includes('modelExplicitlyRejectsVision(healthyProvider.modelConfig') &&
    chatActions.includes('throw new VisionInputUnsupportedError()') &&
    chatActions.includes('content: buildUserMessageContent(textForUserBlock, images, textBlocks)'),
  'image input must be rejected before a text-only model receives it and preserved for vision models'
)
assert(
  providerStore.includes('export function modelExplicitlyRejectsVision') &&
    providerStore.includes('return model.supportsVision === false'),
  'only explicitly text-only models may block image input'
)
assert(
  inputArea.includes('shouldRejectSelectedModelVisionInput') &&
    inputArea.includes('isVisionInputUnsupportedError(error)') &&
    inputArea.includes('setAttachedImages(cloneImageAttachments(submittedDraft.images))'),
  'rejected image sends must stay in the home composer or restore the attachment without a duplicate generic error'
)
assert(
  imageAttachments.includes('export class VisionInputUnsupportedError'),
  'vision input rejection needs a typed send error'
)

console.log('chat-experience verification passed')
