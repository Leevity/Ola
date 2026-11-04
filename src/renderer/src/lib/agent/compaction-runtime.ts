import { useChatStore } from '@renderer/stores/chat-store'
import type { ProviderConfig, UnifiedMessage } from '@renderer/lib/api/types'
import {
  compressMessages,
  isCompactBoundaryMessage,
  isCompactSummaryLikeMessage,
  isCompactSummaryMessage,
  mergeCompressedMessagesKeepHistory,
  type CompressionResult
} from '@renderer/lib/agent/context-compression'
import {
  runPostCompactHooks,
  runPreCompactHooks,
  type CompactHookEmitter
} from '@renderer/lib/agent/compaction-hooks'

export type ManualCompressionResult = 'compressed' | 'skipped' | 'blocked' | 'failed'

export interface ContextCompressionPreview {
  sessionId: string
  targetMessageId: string
  sourceSnapshot: string
  compressedMessages: UnifiedMessage[]
  messagesSummarized: number
  summary: string
}

/**
 * Writes a compaction result into the transcript. The merge helper decides where
 * the compact boundary and summary land relative to existing history; a failed
 * database write must leave the original transcript untouched, so the caller
 * gets `false` rather than a partially replaced session.
 */
export async function mergeCompressedMessagesIntoSession(args: {
  sessionId: string
  compressedMessages: UnifiedMessage[]
  currentMessages?: UnifiedMessage[]
  insertAtEnd?: boolean
  insertBeforeIds?: readonly string[]
  fallbackInsertBeforeIds?: readonly string[]
}): Promise<boolean> {
  const chatStore = useChatStore.getState()
  const currentMessages =
    args.currentMessages ?? (await chatStore.getFullSessionMessagesForMutation(args.sessionId))
  const merged = mergeCompressedMessagesKeepHistory(currentMessages, args.compressedMessages, {
    insertAtEnd: args.insertAtEnd,
    insertBeforeIds: args.insertBeforeIds,
    fallbackInsertBeforeIds: args.fallbackInsertBeforeIds
  })

  if (!merged) return false

  return useChatStore.getState().replaceSessionMessagesPersisted(args.sessionId, merged)
}

export function hasMeaningfulAssistantContent(message: UnifiedMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false
  if (typeof message.content === 'string') return message.content.trim().length > 0
  if (!Array.isArray(message.content)) return false

  return message.content.some((block) => {
    switch (block.type) {
      case 'text':
        return block.text.trim().length > 0
      case 'thinking':
        return block.thinking.trim().length > 0 || !!block.encryptedContent
      case 'tool_use':
      case 'image':
      case 'image_error':
      case 'agent_error':
        return true
      default:
        return false
    }
  })
}

export function shouldInsertCompressedMessagesBeforeAssistant(
  currentMessages: UnifiedMessage[],
  assistantMsgId: string
): boolean {
  const assistantIndex = currentMessages.findIndex((message) => message.id === assistantMsgId)
  if (assistantIndex < 0) return false

  const assistantMessage = currentMessages[assistantIndex]
  if (assistantMessage?.role !== 'assistant') return false
  if (hasMeaningfulAssistantContent(assistantMessage)) return false

  // During the first iteration the assistant message already exists as an empty
  // placeholder. Anchor the compact summary ahead of that placeholder so it
  // lands after the triggering turn instead of sticking to the visual bottom.
  for (let index = assistantIndex + 1; index < currentMessages.length; index += 1) {
    if (currentMessages[index]?.role !== 'system') {
      return false
    }
  }

  return true
}

function getAssistantContentBlockCount(message: UnifiedMessage | undefined): number {
  if (!message || message.role !== 'assistant') return 0
  if (typeof message.content === 'string') return message.content.trim().length > 0 ? 1 : 0
  if (!Array.isArray(message.content)) return 0
  return message.content.length
}

function getLastToolUseId(message: UnifiedMessage | undefined): string | undefined {
  if (!message || !Array.isArray(message.content)) return undefined

  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const block = message.content[index]
    if (block.type === 'tool_use' && block.id) return block.id
  }

  return undefined
}

/**
 * A compaction that fires mid-iteration belongs to the live assistant turn, not
 * to the bottom of the transcript. The anchor records which assistant message
 * and content-block offset the summary card should render after.
 */
export function attachLiveCompactSummaryDisplayAnchor(
  compressedMessages: UnifiedMessage[],
  assistantMessage: UnifiedMessage | undefined,
  assistantMsgId: string
): { messages: UnifiedMessage[]; anchored: boolean } {
  if (!assistantMessage || !Array.isArray(assistantMessage.content)) {
    return { messages: compressedMessages, anchored: false }
  }

  const afterContentBlockCount = getAssistantContentBlockCount(assistantMessage)
  if (afterContentBlockCount <= 0) {
    return { messages: compressedMessages, anchored: false }
  }

  const afterToolUseId = getLastToolUseId(assistantMessage)
  let anchored = false
  const messages = compressedMessages.map((message) => {
    if (!isCompactSummaryMessage(message)) return message
    const compactSummary = message.meta?.compactSummary
    if (!compactSummary) return message

    anchored = true
    return {
      ...message,
      meta: {
        ...(message.meta ?? {}),
        compactSummary: {
          ...compactSummary,
          displayAnchor: {
            assistantMessageId: assistantMsgId,
            afterContentBlockCount,
            ...(afterToolUseId ? { afterToolUseId } : {})
          }
        }
      }
    }
  })

  return { messages, anchored }
}

/** The boundary + summary pair a live compaction contributes to the transcript. */
export function extractCompactArtifactMessages(
  messages?: UnifiedMessage[] | null
): UnifiedMessage[] {
  if (!messages || messages.length === 0) return []

  const boundaryMessage = messages.find((message) => isCompactBoundaryMessage(message))
  const summaryMessage =
    messages.find((message) => isCompactSummaryMessage(message)) ??
    messages.find((message) => isCompactSummaryLikeMessage(message))
  return [boundaryMessage, summaryMessage].filter((message): message is UnifiedMessage => !!message)
}

/**
 * Compacts a transcript with the `preCompact` / `postCompact` hook pair around
 * it. Returns `null` when a hook vetoed the compaction, so both the preview and
 * the apply path treat a veto the same way.
 */
export async function compressWithCompactHooks(
  input: {
    sessionId: string
    projectPath?: string
    messages: UnifiedMessage[]
    config: ProviderConfig
    preTokens: number
    trigger: 'auto' | 'manual'
    focusPrompt?: string
  },
  emit: CompactHookEmitter
): Promise<{ messages: UnifiedMessage[]; result: CompressionResult } | null> {
  const subject = {
    sessionId: input.sessionId,
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
    trigger: input.trigger
  }
  const preCompact = await runPreCompactHooks(emit, subject, input.messages)
  if (preCompact.blocked) return null
  // A hook-supplied focus wins over the caller's: policy decided what the
  // summary must capture for this compaction.
  const focusPrompt = preCompact.focusPrompt ?? input.focusPrompt
  const compressed = await compressMessages(
    input.messages,
    input.config,
    undefined,
    0,
    focusPrompt,
    undefined,
    input.trigger,
    input.preTokens
  )
  return {
    ...compressed,
    messages: await runPostCompactHooks(emit, subject, compressed.messages)
  }
}
