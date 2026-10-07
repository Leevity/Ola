import type {
  AIModelConfig,
  CompactBoundaryMeta,
  ProviderConfig,
  UnifiedMessage
} from '../api/types'
import { isTsRuntimeAvailable, streamTsRuntimeTextTurn } from '@renderer/lib/ipc/ts-runtime-bridge'
import { resolveTsRuntimeModelBinding } from '@renderer/lib/ipc/ts-runtime-model-binding'
import { assessTsRuntimeTextEligibility } from '@renderer/lib/ipc/ts-runtime-text-eligibility'

export interface CompressionConfig {
  enabled: boolean
  /** Model's max context token count. */
  contextLength: number
  /** Full compression trigger threshold, clamped to 0.3 ~ 0.9. */
  threshold: number
  /** Optional pre-compression trigger threshold before buffer adjustments. */
  preCompressThreshold?: number
  /** Tokens reserved for summary/output headroom before trigger calculations. */
  reservedOutputBudget?: number
}

export interface CompressionResult {
  compressed: boolean
  originalCount: number
  newCount: number
  messagesSummarized?: number
}

export const DEFAULT_CONTEXT_COMPRESSION_LIMIT = 200_000
export const DEFAULT_CONTEXT_COMPRESSION_THRESHOLD = 0.8
export const MIN_CONTEXT_COMPRESSION_THRESHOLD = 0.3
export const MAX_CONTEXT_COMPRESSION_THRESHOLD = 0.9
export const DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS = 20_000
export const CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS = 13_000
export const CONTEXT_COMPRESSION_PRE_BUFFER_TOKENS = 20_000
export const CONTEXT_COMPRESSION_PRE_GAP_TOKENS = 8_000

const DEFAULT_PRECOMPRESS_THRESHOLD = 0.65
const TS_COMPRESSION_SESSION_SCOPE = 'context-compression'
const TS_COMPRESSION_SYSTEM_PROMPT =
  'You compress long AI coding-agent conversations into durable working memory. ' +
  'Preserve exact user intent, constraints, decisions, files touched, errors, test results, ' +
  'open tasks, and any facts needed to continue safely. Omit filler and obsolete details. ' +
  'Return only a concise Markdown summary, with no preface.'
const LEGACY_SUMMARY_PREFIXES = [
  '[Context Memory Compressed Summary]',
  '[Context Memory Compressed Summary]',
  '[Context Memory Compressed Summary'
]

export function resetCompressionFailures(): void {
  // Main TS runtime owns the summarizer circuit breaker.
}

export function clampCompressionThreshold(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_COMPRESSION_THRESHOLD
  }
  return Math.min(
    MAX_CONTEXT_COMPRESSION_THRESHOLD,
    Math.max(MIN_CONTEXT_COMPRESSION_THRESHOLD, value)
  )
}

export function resolveCompressionThreshold(
  modelConfigOrThreshold?: Pick<AIModelConfig, 'contextCompressionThreshold'> | number | null
): number {
  return clampCompressionThreshold(
    typeof modelConfigOrThreshold === 'number'
      ? modelConfigOrThreshold
      : modelConfigOrThreshold?.contextCompressionThreshold
  )
}

export function resolveCompressionContextLength(
  modelConfig?: Pick<AIModelConfig, 'contextLength' | 'enableExtendedContextCompression'> | null
): number {
  const configuredContextLength =
    typeof modelConfig?.contextLength === 'number' && modelConfig.contextLength > 0
      ? modelConfig.contextLength
      : DEFAULT_CONTEXT_COMPRESSION_LIMIT

  if (configuredContextLength <= DEFAULT_CONTEXT_COMPRESSION_LIMIT) {
    return configuredContextLength
  }

  if (modelConfig?.enableExtendedContextCompression === false) {
    return DEFAULT_CONTEXT_COMPRESSION_LIMIT
  }

  return configuredContextLength
}

export function resolveCompressionReservedOutputBudget(
  modelConfig?: Pick<AIModelConfig, 'maxOutputTokens'> | null
): number {
  const maxOutputTokens =
    typeof modelConfig?.maxOutputTokens === 'number' && modelConfig.maxOutputTokens > 0
      ? Math.floor(modelConfig.maxOutputTokens)
      : DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS
  return Math.min(DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS, maxOutputTokens)
}

export function getEffectiveContextWindow(config: CompressionConfig): number {
  if (config.contextLength <= 0) return 0
  const reserved = Math.max(
    0,
    config.reservedOutputBudget ?? DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS
  )
  return Math.max(1, config.contextLength - reserved)
}

export function getCompressionTriggerTokens(config: CompressionConfig): number {
  const effectiveWindow = getEffectiveContextWindow(config)
  if (effectiveWindow <= 0) return 0
  const ratioThreshold = Math.floor(effectiveWindow * config.threshold)
  const bufferedThreshold = effectiveWindow - CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS
  return Math.max(
    1,
    Math.min(ratioThreshold, bufferedThreshold > 0 ? bufferedThreshold : ratioThreshold)
  )
}

export function getPreCompressionTriggerTokens(config: CompressionConfig): number {
  const effectiveWindow = getEffectiveContextWindow(config)
  if (effectiveWindow <= 0) return 0

  const preThreshold = config.preCompressThreshold ?? DEFAULT_PRECOMPRESS_THRESHOLD
  const ratioThreshold = Math.floor(effectiveWindow * preThreshold)
  const fullThreshold = getCompressionTriggerTokens(config)
  const candidates = [ratioThreshold]
  const bufferedThreshold = effectiveWindow - CONTEXT_COMPRESSION_PRE_BUFFER_TOKENS
  if (bufferedThreshold > 0) candidates.push(bufferedThreshold)
  const gapThreshold = fullThreshold - CONTEXT_COMPRESSION_PRE_GAP_TOKENS
  if (gapThreshold > 0) candidates.push(gapThreshold)
  const threshold = Math.min(...candidates)
  return Math.max(1, Math.min(threshold, Math.max(1, fullThreshold - 1)))
}

export function shouldCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  // The Main TS runtime owns summarizer failure handling and falls back to local
  // truncation when needed, so the renderer should keep triggering above the
  // token threshold to guarantee the context stays bounded.
  return inputTokens >= getCompressionTriggerTokens(config)
}

export function shouldPreCompress(inputTokens: number, config: CompressionConfig): boolean {
  void inputTokens
  void config
  void getPreCompressionTriggerTokens
  return false
}

function compressionMessageText(message: UnifiedMessage): string {
  if (typeof message.content === 'string') return message.content.trim()
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map((block) => {
      const value = block as unknown as Record<string, unknown>
      switch (value.type) {
        case 'text':
          return typeof value.text === 'string' ? value.text : ''
        case 'tool_use': {
          const input = value.input
          let serialized = '{}'
          try {
            serialized = JSON.stringify(input ?? {})
          } catch {
            serialized = '{}'
          }
          return `[Tool call: ${typeof value.name === 'string' ? value.name : ''}] ${serialized.slice(0, 500)}`
        }
        case 'tool_result': {
          let serialized = ''
          try {
            serialized =
              typeof value.content === 'string'
                ? value.content
                : JSON.stringify(value.content ?? '')
          } catch {
            serialized = ''
          }
          const suffix = value.isError === true ? ' error' : ''
          return `[Tool result${suffix}] ${serialized.slice(0, 800)}`
        }
        case 'image':
          return '[image attachment]'
        case 'image_error':
          return `[Image error: ${typeof value.message === 'string' ? value.message : ''}]`
        case 'agent_error':
          return `[Agent error: ${typeof value.message === 'string' ? value.message : ''}]`
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function compressionToolBlocks(message: UnifiedMessage): Record<string, unknown>[] {
  if (!Array.isArray(message.content)) return []
  return message.content.map((block) => block as unknown as Record<string, unknown>)
}

function findCompressionBoundary(
  messages: readonly UnifiedMessage[],
  initialBoundary: number
): number {
  let boundary = Math.max(1, Math.min(initialBoundary, messages.length))
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const compressedToolUseIds = new Set<string>()
    for (const message of messages.slice(0, boundary)) {
      for (const block of compressionToolBlocks(message)) {
        if (block.type === 'tool_use' && typeof block.id === 'string' && block.id) {
          compressedToolUseIds.add(block.id)
        }
      }
    }
    let split = false
    for (const message of messages.slice(boundary)) {
      for (const block of compressionToolBlocks(message)) {
        if (
          block.type === 'tool_result' &&
          typeof block.toolUseId === 'string' &&
          compressedToolUseIds.has(block.toolUseId)
        ) {
          split = true
          break
        }
      }
      if (split) break
    }
    if (!split) return boundary
    boundary = Math.max(1, boundary - 1)
  }
  return boundary
}

function findOriginalCompressionTask(messages: readonly UnifiedMessage[]): UnifiedMessage | null {
  return (
    messages.find((message) => {
      if (message.role !== 'user' || message.meta?.compactSummary) return false
      if (typeof message.content === 'string') return Boolean(message.content.trim())
      if (!Array.isArray(message.content)) return false
      return message.content.some((block) => ['text', 'image'].includes(block.type))
    }) ?? null
  )
}

function buildCompressionPrompt(
  messages: readonly UnifiedMessage[],
  focusPrompt?: string,
  pinnedContext?: string
): string {
  const parts: string[] = []
  const originalTask = findOriginalCompressionTask(messages)
  if (originalTask) {
    parts.push('## Original Task', compressionMessageText(originalTask))
  }
  if (pinnedContext?.trim()) parts.push('## Pinned Plan Context', pinnedContext.trim())
  parts.push(
    '## Full Conversation History',
    messages
      .map((message) => {
        const role = message.role.toUpperCase()
        const content = compressionMessageText(message)
        return content ? `[${role}]: ${content}` : ''
      })
      .filter(Boolean)
      .join('\n\n')
  )
  const focus = focusPrompt?.trim()
    ? `\n\nSpecial focus requested by the user: ${focusPrompt.trim()}`
    : ''
  return `Summarize the conversation below so another agent can continue from the current state.${focus}\n\nReturn only the summary.\n\n${parts.join('\n\n')}`
}

function normalizeCompressionSummary(value: string): string {
  return value
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<analysis\b[^>]*>[\s\S]*?(?:<\/analysis>|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function tryTsRuntimeCompression(args: {
  messages: UnifiedMessage[]
  provider: ProviderConfig
  signal?: AbortSignal
  preserveCount: number
  focusPrompt?: string
  pinnedContext?: string
  trigger: 'auto' | 'manual'
  preTokens: number
}): Promise<{ messages: UnifiedMessage[]; result: CompressionResult }> {
  const originalCount = args.messages.length
  const minMessagesToCompress = args.trigger === 'manual' ? 1 : 2
  const effectivePreserveCount = Math.min(
    Math.max(0, args.preserveCount),
    Math.max(0, originalCount - minMessagesToCompress)
  )
  if (originalCount < effectivePreserveCount + minMessagesToCompress) {
    return {
      messages: args.messages,
      result: { compressed: false, originalCount, newCount: originalCount }
    }
  }
  const boundaryIndex = findCompressionBoundary(
    args.messages,
    args.messages.length - effectivePreserveCount
  )
  const messagesToCompress = args.messages.slice(0, boundaryIndex)
  const messagesToPreserve = args.messages.slice(boundaryIndex)
  if (messagesToCompress.length < minMessagesToCompress) {
    return {
      messages: args.messages,
      result: { compressed: false, originalCount, newCount: originalCount }
    }
  }

  const binding = resolveTsRuntimeModelBinding(args.provider)
  if (!binding || !(await isTsRuntimeAvailable())) {
    throw new Error('TS_RUNTIME_COMPRESSION_UNAVAILABLE')
  }

  const prompt = buildCompressionPrompt(messagesToCompress, args.focusPrompt, args.pinnedContext)
  const eligibility = assessTsRuntimeTextEligibility({
    messages: [{ id: 'context-compression', role: 'user', content: prompt, createdAt: Date.now() }],
    provider: args.provider,
    modelSource: binding.modelSource
  })
  if (!eligibility.eligible) throw new Error('TS_RUNTIME_COMPRESSION_UNSUPPORTED')
  if (!args.provider.sessionId) throw new Error('TS_RUNTIME_COMPRESSION_SESSION_REQUIRED')

  let summary = ''
  for await (const event of streamTsRuntimeTextTurn({
    workspaceId: binding.workspaceId,
    sessionId: args.provider.sessionId,
    modelSource: binding.modelSource,
    modelOptions: {
      ...eligibility.modelOptions,
      systemPrompt: TS_COMPRESSION_SYSTEM_PROMPT,
      thinking: { type: 'disabled' },
      temperature: 0,
      responsesSessionScope: TS_COMPRESSION_SESSION_SCOPE
    },
    prompt,
    maxTurns: 1,
    signal: args.signal
  })) {
    if (event.type === 'text_delta' && event.text) summary += event.text
    if (event.type === 'loop_end') break
    if (event.type === 'error') throw event.error
  }
  summary = normalizeCompressionSummary(summary)
  if (!summary) throw new Error('TS_RUNTIME_COMPRESSION_EMPTY_SUMMARY')

  const summaryId = `oc_${crypto.randomUUID()}`
  const boundaryId = `oc_${crypto.randomUUID()}`
  const headId = messagesToPreserve[0]?.id
  const tailId = messagesToPreserve.at(-1)?.id
  const boundary: UnifiedMessage = {
    id: boundaryId,
    role: 'system',
    content: 'Conversation compacted',
    createdAt: Date.now(),
    meta: {
      compactBoundary: {
        trigger: args.trigger,
        preTokens: args.preTokens,
        messagesSummarized: messagesToCompress.length,
        ...(headId && tailId ? { preservedSegment: { headId, anchorId: summaryId, tailId } } : {})
      }
    }
  }
  const summaryMessage: UnifiedMessage = {
    id: summaryId,
    role: 'user',
    content:
      `[Context Memory Compressed Summary]\n\nThe following summary covers ${messagesToCompress.length} earlier messages. ` +
      'Continue from this summary plus any messages that appear after the compression point.\n\n' +
      summary,
    createdAt: Date.now(),
    meta: {
      compactSummary: {
        messagesSummarized: messagesToCompress.length,
        recentMessagesPreserved: messagesToPreserve.length > 0
      }
    }
  }
  const compressedMessages = [boundary, summaryMessage, ...messagesToPreserve]
  return {
    messages: compressedMessages,
    result: {
      compressed: true,
      originalCount,
      newCount: compressedMessages.length,
      messagesSummarized: messagesToCompress.length
    }
  }
}

export function isCompactBoundaryMessage(message: UnifiedMessage): boolean {
  return message.role === 'system' && !!message.meta?.compactBoundary
}

export function isCompactSummaryMessage(message: UnifiedMessage): boolean {
  return message.role === 'user' && !!message.meta?.compactSummary
}

export function isLegacyCompactSummaryMessage(message: UnifiedMessage): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string') return false
  const content = message.content.trim()
  return LEGACY_SUMMARY_PREFIXES.some((prefix) => content.startsWith(prefix))
}

export function isCompactSummaryLikeMessage(message: UnifiedMessage): boolean {
  return isCompactSummaryMessage(message) || isLegacyCompactSummaryMessage(message)
}

export interface ActiveCompactArtifacts {
  boundaryId: string | null
  boundaryIndex: number
  summaryId: string | null
  summaryIndex: number
}

export function isCompactArtifactMessage(message: UnifiedMessage): boolean {
  return isCompactBoundaryMessage(message) || isCompactSummaryLikeMessage(message)
}

function findCompactSummaryIndexAfterBoundary(
  messages: UnifiedMessage[],
  boundaryIndex: number
): number {
  for (let index = boundaryIndex + 1; index < messages.length; index += 1) {
    if (isCompactBoundaryMessage(messages[index])) return -1
    if (isCompactSummaryLikeMessage(messages[index])) return index
  }
  return -1
}

export function resolveActiveCompactArtifacts(
  messages: readonly UnifiedMessage[]
): ActiveCompactArtifacts | null {
  const items = [...messages]
  let active: ActiveCompactArtifacts | null = null
  let activeScore = Number.NEGATIVE_INFINITY

  for (let boundaryIndex = 0; boundaryIndex < items.length; boundaryIndex += 1) {
    const boundary = items[boundaryIndex]
    if (!isCompactBoundaryMessage(boundary)) continue

    const summaryIndex = findCompactSummaryIndexAfterBoundary(items, boundaryIndex)
    if (summaryIndex < 0) continue

    const summary = items[summaryIndex]
    const score = Math.max(boundary.createdAt, summary.createdAt)
    if (score < activeScore) continue

    activeScore = score
    active = {
      boundaryId: boundary.id,
      boundaryIndex,
      summaryId: summary.id,
      summaryIndex
    }
  }

  if (active) return active

  for (let summaryIndex = 0; summaryIndex < items.length; summaryIndex += 1) {
    const summary = items[summaryIndex]
    if (!isCompactSummaryLikeMessage(summary)) continue
    if (summary.createdAt < activeScore) continue
    activeScore = summary.createdAt
    active = {
      boundaryId: null,
      boundaryIndex: -1,
      summaryId: summary.id,
      summaryIndex
    }
  }

  return active
}

export function extractUnifiedMessageText(message?: UnifiedMessage | null): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content.trim()
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}

function splitCompactSummaryBlocks(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
}

function isCompactSummaryTitleBlock(block: string): boolean {
  const trimmed = block.trim()
  if (!trimmed) return false
  if (LEGACY_SUMMARY_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return true
  }
  if (!/^\[[^\]\n]+]$/.test(trimmed)) {
    return false
  }
  return (
    /summary|compressed|compacted|memory/i.test(trimmed) ||
    /[\u4e0a\u4e0b\u6587\u6458\u8981\u538b\u7f29]/u.test(trimmed)
  )
}

function isCompactSummaryIntroBlock(block: string): boolean {
  const normalized = block.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > 320) {
    return false
  }
  return [
    /this session is being continued/i,
    /continued from a previous conversation/i,
    /the following summary covers/i,
    /recent messages are preserved/i,
    /\u672c\u6b21\u4f1a\u8bdd.*\u7ee7\u7eed/u,
    /\u4ee5\u4e0b\u6458\u8981.*\u6d88\u606f/u,
    /\u8fd1\u671f\u6d88\u606f.*\u4fdd\u7559/u
  ].some((pattern) => pattern.test(normalized))
}

export function getCompactSummaryDisplayText(message: UnifiedMessage): string {
  const text = extractUnifiedMessageText(message)
  if (!text || !isCompactSummaryLikeMessage(message)) {
    return text
  }

  const blocks = splitCompactSummaryBlocks(text)
  if (blocks.length === 0) {
    return text
  }

  let startIndex = 0
  if (isCompactSummaryTitleBlock(blocks[startIndex]!)) {
    startIndex += 1
  }
  if (startIndex < blocks.length - 1 && isCompactSummaryIntroBlock(blocks[startIndex]!)) {
    startIndex += 1
  }

  return blocks.slice(startIndex).join('\n\n').trim() || text
}

export function mergeCompressedMessagesIntoConversation(
  currentMessages: UnifiedMessage[],
  compressedMessages?: UnifiedMessage[] | null
): UnifiedMessage[] | null {
  if (!compressedMessages || compressedMessages.length === 0) {
    return null
  }

  const summaryIndex = compressedMessages.findIndex((message) =>
    isCompactSummaryLikeMessage(message)
  )
  if (summaryIndex < 0) {
    return null
  }

  const boundaryMessage = compressedMessages.find((message) => isCompactBoundaryMessage(message))
  const preservedHeadId =
    boundaryMessage?.meta?.compactBoundary?.preservedSegment?.headId ??
    compressedMessages[summaryIndex + 1]?.id ??
    null

  const compressedIndexById = new Map(
    compressedMessages.map((message, index) => [message.id, index])
  )
  const currentIndexById = new Map(currentMessages.map((message, index) => [message.id, index]))

  const anchorId =
    (preservedHeadId &&
    compressedIndexById.has(preservedHeadId) &&
    currentIndexById.has(preservedHeadId)
      ? preservedHeadId
      : null) ??
    [...currentMessages].reverse().find((message) => compressedIndexById.has(message.id))?.id ??
    null

  if (!anchorId) {
    return null
  }

  const compressedTailIndex = compressedIndexById.get(anchorId) ?? -1
  const currentTailIndex = currentIndexById.get(anchorId) ?? -1

  if (compressedTailIndex < 0 || currentTailIndex < 0) {
    return null
  }

  const currentTail = currentMessages
    .slice(currentTailIndex)
    .filter((message) => !isCompactArtifactMessage(message))

  return [...compressedMessages.slice(0, compressedTailIndex), ...currentTail]
}

/**
 * Insert the compression artifacts into the existing transcript without dropping
 * the older messages. The agent loop continues to send the compressed history to
 * the LLM, but the UI keeps the full transcript visible — the boundary + summary
 * pair just acts as an inline divider that says "from this point on the model only
 * sees the summary".
 *
 * By default this inserts at the compact boundary used by the request view.
 * Callers may pass an explicit display insertion point so the UI can show the
 * summary at the chronological moment compression happened while the request
 * builder still reconstructs the reduced model view from compact metadata.
 */
export function mergeCompressedMessagesKeepHistory(
  currentMessages: UnifiedMessage[],
  compressedMessages?: UnifiedMessage[] | null,
  options: {
    insertAtEnd?: boolean
    insertBeforeIds?: readonly string[]
    fallbackInsertBeforeIds?: readonly string[]
  } = {}
): UnifiedMessage[] | null {
  if (!compressedMessages || compressedMessages.length === 0) {
    return null
  }

  const boundaryMessage = compressedMessages.find((message) => isCompactBoundaryMessage(message))
  // Prefer the meta-tagged summary so a legacy `[Context Memory Compressed Summary]`
  // user message that happened to live inside the preserved tail can't shadow the
  // freshly-emitted summary at the head.
  const summaryMessage =
    compressedMessages.find((message) => isCompactSummaryMessage(message)) ??
    compressedMessages.find((message) => isCompactSummaryLikeMessage(message))
  if (!boundaryMessage || !summaryMessage) {
    return null
  }

  const currentMessagesWithoutIncomingCompactArtifacts = currentMessages.filter(
    (message) => message.id !== boundaryMessage.id && message.id !== summaryMessage.id
  )
  const currentIds = new Set(
    currentMessagesWithoutIncomingCompactArtifacts.map((message) => message.id)
  )

  // Skip the merge entirely if the boundary is already wired into the transcript
  // (e.g. resume of a previously-compressed conversation). Return a shallow copy
  // so the caller can safely mutate the result without poking at frozen state.
  if (
    currentMessages.some((message) => message.id === boundaryMessage.id) &&
    currentMessages.some((message) => message.id === summaryMessage.id)
  ) {
    return [...currentMessages]
  }

  const preservedHeadId = boundaryMessage.meta?.compactBoundary?.preservedSegment?.headId ?? null

  // Prefer an explicit UI insertion point when supplied. Otherwise fall back to
  // the preserved tail's head so any current user message kept outside the
  // summary stays after the compact boundary in both UI and request order.
  let insertIndex = -1
  if (options.insertAtEnd) {
    insertIndex = currentMessagesWithoutIncomingCompactArtifacts.length
  }
  if (insertIndex < 0) {
    for (const insertBeforeId of options.insertBeforeIds ?? []) {
      if (!insertBeforeId) continue
      insertIndex = currentMessagesWithoutIncomingCompactArtifacts.findIndex(
        (message) => message.id === insertBeforeId
      )
      if (insertIndex >= 0) break
    }
  }
  // Locate the preserved tail's head inside the current transcript. When the
  // boundary's preservedSegment is missing or stale, fall back to the first
  // message after the boundary/summary pair in the compressed payload that the
  // current transcript still knows about. As a last resort (no preserved tail at
  // all — e.g. manual /compress that summarized everything), append at the very
  // end so the boundary still renders, rather than dropping the merge.
  if (insertIndex < 0) {
    if (preservedHeadId && currentIds.has(preservedHeadId)) {
      insertIndex = currentMessagesWithoutIncomingCompactArtifacts.findIndex(
        (message) => message.id === preservedHeadId
      )
    }
    if (insertIndex < 0) {
      const summaryIndex = compressedMessages.indexOf(summaryMessage)
      for (let index = summaryIndex + 1; index < compressedMessages.length; index += 1) {
        const candidateId = compressedMessages[index]?.id
        if (candidateId && currentIds.has(candidateId)) {
          insertIndex = currentMessagesWithoutIncomingCompactArtifacts.findIndex(
            (message) => message.id === candidateId
          )
          if (insertIndex >= 0) break
        }
      }
    }
  }
  if (insertIndex < 0) {
    for (const fallbackId of options.fallbackInsertBeforeIds ?? []) {
      if (!fallbackId) continue
      insertIndex = currentMessagesWithoutIncomingCompactArtifacts.findIndex(
        (message) => message.id === fallbackId
      )
      if (insertIndex >= 0) break
    }
  }
  if (insertIndex < 0) {
    insertIndex = currentMessagesWithoutIncomingCompactArtifacts.length
  }

  return [
    ...currentMessagesWithoutIncomingCompactArtifacts.slice(0, insertIndex),
    boundaryMessage,
    summaryMessage,
    ...currentMessagesWithoutIncomingCompactArtifacts.slice(insertIndex)
  ]
}

/**
 * After loop_end, splice the agent loop's post-compression message array into
 * the renderer's kept-history transcript without dropping the older messages.
 *
 * The agent loop only carries the post-compression view ([boundary, summary,
 * ...newTurns]). The renderer transcript carries the full history
 * with the boundary inserted in the middle ([...oldHistory, boundary, summary,
 * ...newTurns, ...trailingMarkers]). To keep the older messages
 * we splice agentMessages[boundaryIdx..] over currentMessages[boundaryIdx..]
 * while preserving any trailing items the agent never had (e.g. the persistent
 * compression status marker).
 *
 * During a live renderer run, the loop-local assistant/tool-result messages use
 * internal IDs while the UI streams into the stable `runId` assistant message.
 * Once the compression event has already inserted the boundary + summary, the
 * renderer tail is authoritative and replacing it here would duplicate or hide
 * the content that streamed after compression.
 */
export function mergeLoopEndMessagesKeepHistory(
  currentMessages: UnifiedMessage[],
  agentMessages: UnifiedMessage[]
): UnifiedMessage[] | null {
  const boundaryInAgent = agentMessages.find(isCompactBoundaryMessage)
  if (!boundaryInAgent) return null

  const summaryInAgent = agentMessages.find((message) => isCompactSummaryMessage(message))
  const currentIds = new Set(currentMessages.map((message) => message.id))
  if (summaryInAgent && currentIds.has(boundaryInAgent.id) && currentIds.has(summaryInAgent.id)) {
    return null
  }

  const boundaryIdxAgent = agentMessages.indexOf(boundaryInAgent)
  const boundaryIdxCurrent = currentMessages.findIndex(
    (message) => message.id === boundaryInAgent.id
  )
  if (boundaryIdxCurrent < 0 || boundaryIdxAgent < 0) return null

  const agentMessageIds = new Set(agentMessages.map((message) => message.id))
  // Trailing renderer-only markers (e.g. the compression status placeholder) sit
  // after the last message the agent still knows about. Walk back from the end
  // of currentMessages looking for the most recent overlap with agentMessages.
  // Bound is `> boundaryIdxCurrent` (not `>=`) — a boundary-only overlap means
  // the renderer view past the boundary diverged completely, so treat it as no
  // tail overlap rather than slicing in the renderer's existing summary
  // tail and duplicating it.
  let agentLastIdxInCurrent = -1
  for (let i = currentMessages.length - 1; i > boundaryIdxCurrent; i -= 1) {
    if (agentMessageIds.has(currentMessages[i].id)) {
      agentLastIdxInCurrent = i
      break
    }
  }
  const trailingItems =
    agentLastIdxInCurrent >= 0 ? currentMessages.slice(agentLastIdxInCurrent + 1) : []

  return [
    ...currentMessages.slice(0, boundaryIdxCurrent),
    ...agentMessages.slice(boundaryIdxAgent),
    ...trailingItems
  ]
}

export async function compressMessages(
  messages: UnifiedMessage[],
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  preserveCount = 0,
  focusPrompt?: string,
  pinnedContext?: string,
  trigger: CompactBoundaryMeta['trigger'] = 'manual',
  preTokens = 0
): Promise<{ messages: UnifiedMessage[]; result: CompressionResult }> {
  if (signal?.aborted) {
    throw new Error('aborted')
  }

  return tryTsRuntimeCompression({
    messages,
    provider: providerConfig,
    signal,
    preserveCount,
    ...(focusPrompt ? { focusPrompt } : {}),
    ...(pinnedContext?.trim() ? { pinnedContext: pinnedContext.trim() } : {}),
    trigger,
    preTokens
  })
}
