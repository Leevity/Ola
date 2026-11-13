import { useCallback, useEffect } from 'react'
import { nanoid } from 'nanoid'
import { toast } from 'sonner'
import i18n from '@renderer/locales'
import { useChatStore } from '@renderer/stores/chat-store'
import { resolveReasoningEffortForModel, useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { encodeToolError } from '@renderer/lib/tools/tool-result-format'
import { useTeamStore } from '@renderer/stores/team-store'
import { invokeMessagePack } from '@renderer/lib/ipc/messagepack-ipc-client'
import { DB_MESSAGES_TRUNCATE_FROM_MSGPACK_CHANNEL } from '../../../shared/messagepack/binary-ipc'
import type { UnifiedMessage, ProviderConfig } from '@renderer/lib/api/types'
import {
  cloneImageAttachments,
  hasEditableDraftContent,
  type EditableUserMessageDraft,
  type ImageAttachment
} from '@renderer/lib/image-attachments'
import { type SystemCommandSnapshot } from '@renderer/lib/commands/system-command'
import {
  getCompactSummaryDisplayText,
  isCompactSummaryMessage
} from '@renderer/lib/agent/context-compression'
import {
  appendRuntimeTextDelta,
  flushBackgroundSessionToForeground
} from '@renderer/lib/agent/session-runtime-router'
import { installMemoryAutomationDailyRollup } from '@renderer/lib/agent/memory-automation'
import { getTailToolExecutionState } from '@renderer/components/chat/transcript-utils'
import { clearPendingSessionMessages } from '@renderer/hooks/use-pending-session-queue'
import type { MessageSource, SendMessageOptions } from '@renderer/hooks/send-message-options'
import {
  acquireGoalContinuationListener,
  buildDeletedMessages,
  collectAvailableContinuationToolResults,
  CONTINUE_TOOL_TAIL_WINDOW_MESSAGES,
  continuingToolExecutionSessions,
  emitHooks,
  ensureTeamLeadListener,
  findEditableUserMessageById,
  findLastEditableUserMessage,
  findRetryAssistantTarget,
  getSendMessageHandler,
  hasActiveSessionRun,
  normalizeContinuationErrorMessage,
  resolveSessionMessageTarget,
  scheduleDrain,
  setSendMessageHandler,
  setStreamingMessageIdWithSync,
  shouldSuppressTransientRuntimeError,
  stopSessionStreaming,
  tryDispatchPendingGoalContinuation
} from '@renderer/lib/agent/chat-turn-control'
import {
  compressWithCompactHooks,
  mergeCompressedMessagesIntoSession
} from '@renderer/lib/agent/compaction-runtime'
import { estimateManualCompressionInputTokens } from '@renderer/lib/agent/context-usage'
import { ensureTokenEncoder } from '@renderer/lib/token-encoder'
import {
  type ManualCompressionResult,
  type ContextCompressionPreview
} from '@renderer/lib/agent/compaction-runtime'
import { sendChatMessage } from '@renderer/lib/agent/chat-send-message'

// Turn control lives in lib/agent/chat-turn-control.ts; re-exported here so the
// existing component imports keep working unchanged.
export {
  abortSession,
  dispatchNextQueuedMessageForSession,
  hasActiveSessionRunForSession,
  promotePendingSessionMessageForImmediateDispatch,
  quotePendingSessionMessageIntoConversation,
  resetTeamAutoTrigger,
  stopSessionStreaming
} from '@renderer/lib/agent/chat-turn-control'

// Queue state lives in use-pending-session-queue.ts; re-exported here so the
// existing component imports keep working unchanged.
export {
  clearPendingSessionMessages,
  getPendingSessionMessageCountForSession,
  getPendingSessionMessages,
  hasPendingSessionMessagesForSession,
  hydratePendingSessionQueue,
  isPendingSessionDispatchPaused,
  removePendingSessionMessage,
  subscribePendingSessionMessages,
  updatePendingSessionMessageDraft
} from '@renderer/hooks/use-pending-session-queue'
export type { PendingSessionMessageItem } from '@renderer/hooks/use-pending-session-queue'
export type { MessageSource, SendMessageOptions } from '@renderer/hooks/send-message-options'

export type {
  ContextCompressionPreview,
  ManualCompressionResult
} from '@renderer/lib/agent/compaction-runtime'

// Plan execution helpers live in lib/agent/chat-send-message.ts; re-exported so
// the existing panel imports keep working unchanged.
export {
  sendImplementPlan,
  sendImplementPlanInNewSession,
  sendPlanRevision
} from '@renderer/lib/agent/chat-send-message'
export function useChatActions(): {
  sendMessage: (
    text: string,
    images?: ImageAttachment[],
    source?: MessageSource,
    targetSessionId?: string,
    commandOverride?: SystemCommandSnapshot | null,
    reuseAssistantMessageId?: string,
    options?: SendMessageOptions
  ) => Promise<void>
  stopStreaming: () => void
  continueLastToolExecution: () => Promise<void>
  retryLastMessage: () => Promise<void>
  editAndResend: (messageId: string, draft: EditableUserMessageDraft) => Promise<void>
  deleteMessage: (messageId: string) => Promise<void>
  manualCompressContext: (focusPrompt?: string) => Promise<ManualCompressionResult>
  previewContextCompressionAt: (messageId: string) => Promise<ContextCompressionPreview | null>
  applyContextCompressionPreview: (
    preview: ContextCompressionPreview
  ) => Promise<ManualCompressionResult>
} {
  const activeSessionId = useChatStore((state) => state.activeSessionId)

  useEffect(() => {
    if (!activeSessionId) return
    let cancelled = false
    // IIFE so we can await inside useEffect. The cancelled flag avoids applying the
    // snapshot if the user switches away again mid-flush (rare but possible during
    // rapid session hopping). The flush itself is idempotent — if cancelled fires the
    // snapshot has already been atomically drained by takeSessionSnapshot, so the data
    // is not lost.
    ;(async () => {
      try {
        await flushBackgroundSessionToForeground(activeSessionId)
      } catch (err) {
        if (!cancelled) console.error('[useChatActions] flush background failed', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeSessionId])

  const sendMessage = useCallback(sendChatMessage, [])

  useEffect(() => {
    installMemoryAutomationDailyRollup()
    ensureTeamLeadListener()
    if (useTeamStore.getState().activeTeam) {
      scheduleDrain()
    }
  }, [])

  useEffect(() => {
    return acquireGoalContinuationListener()
  }, [])

  useEffect(() => {
    let previous = useUIStore.getState().planModesBySession
    return useUIStore.subscribe((state) => {
      const next = state.planModesBySession
      for (const [sessionId, enabled] of Object.entries(previous ?? {})) {
        if (!enabled || next?.[sessionId]) continue
        tryDispatchPendingGoalContinuation(sessionId)
      }
      previous = next
    })
  }, [])

  // IPC listeners (session-control and runtime tools/approval) are registered
  // at module level above — no useEffect needed here.

  // Cron session delivery is handled by the main-process CronAgent background runtime.
  // No cron event subscription needed here.

  // Keep module-level ref updated for team lead auto-trigger + plugin auto-reply
  setSendMessageHandler(sendMessage)

  const stopStreaming = useCallback(() => {
    // Stop the active session's agent
    const activeId = useChatStore.getState().activeSessionId
    if (activeId) {
      stopSessionStreaming(activeId)
    }
  }, [])

  const continueLastToolExecution = useCallback(async () => {
    const chatStore = useChatStore.getState()
    const agentStore = useAgentStore.getState()
    const sessionId = chatStore.activeSessionId
    if (!sessionId) return
    if (hasActiveSessionRun(sessionId)) return
    if (continuingToolExecutionSessions.has(sessionId)) return
    continuingToolExecutionSessions.add(sessionId)

    try {
      await chatStore.loadRecentSessionMessages(sessionId, true, CONTINUE_TOOL_TAIL_WINDOW_MESSAGES)
    } catch (error) {
      continuingToolExecutionSessions.delete(sessionId)
      throw error
    }
    const messages = chatStore.getSessionMessages(sessionId)
    const tailToolExecution = getTailToolExecutionState(messages)
    if (!tailToolExecution) {
      continuingToolExecutionSessions.delete(sessionId)
      return
    }

    const resumedAssistantMessageId = tailToolExecution.assistantMessageId
    let handedOffToSendMessage = false

    setStreamingMessageIdWithSync(sessionId, resumedAssistantMessageId)
    agentStore.setRunning(true)

    try {
      const { toolResultsById, missingToolUses } = collectAvailableContinuationToolResults(
        sessionId,
        tailToolExecution
      )

      // Continue must only bridge saved tool results back to the model; replaying historical
      // tool_use blocks can repeat writes, shell commands, or other side effects.
      if (missingToolUses.length > 0) {
        const names = Array.from(new Set(missingToolUses.map((toolUse) => toolUse.name)))
          .slice(0, 3)
          .join(', ')
        toast.error('Cannot continue safely', {
          description: `Missing saved results for ${missingToolUses.length} previous tool call${
            missingToolUses.length === 1 ? '' : 's'
          }${names ? ` (${names})` : ''}. Retry the turn instead of replaying tools.`
        })
        return
      }

      const consolidatedToolResults = tailToolExecution.toolUseBlocks.map((toolUse) => {
        const existingResult = toolResultsById.get(toolUse.id)
        if (existingResult) {
          return {
            type: 'tool_result' as const,
            toolUseId: toolUse.id,
            content: existingResult.content,
            ...(existingResult.isError ? { isError: true } : {})
          }
        }

        const fallbackOutput = encodeToolError('Tool continuation failed')
        return {
          type: 'tool_result' as const,
          toolUseId: toolUse.id,
          content: fallbackOutput,
          isError: true
        }
      })

      const nextMessages: UnifiedMessage[] = [
        ...messages.slice(0, tailToolExecution.assistantIndex + 1),
        {
          id: nanoid(),
          role: 'user',
          content: consolidatedToolResults,
          createdAt: Date.now()
        }
      ]

      chatStore.replaceSessionMessages(sessionId, nextMessages)
      handedOffToSendMessage = true
      await sendMessage('', undefined, 'continue', sessionId, undefined, resumedAssistantMessageId)
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err)
      const normalizedMessage = normalizeContinuationErrorMessage(rawMessage)
      const apiErrorDetail =
        rawMessage.includes('{') && rawMessage.includes('}')
          ? normalizeContinuationErrorMessage(rawMessage.replace(/^.*?(\{.*\})\s*$/s, '$1'))
          : normalizedMessage
      console.error('[Continue Tool Execution]', err)
      if (!shouldSuppressTransientRuntimeError(apiErrorDetail)) {
        toast.error('Continue execution failed', { description: apiErrorDetail })
        appendRuntimeTextDelta(
          sessionId,
          resumedAssistantMessageId,
          `\n\n> **Error:** ${apiErrorDetail}`
        )
      }
    } finally {
      continuingToolExecutionSessions.delete(sessionId)
      if (!handedOffToSendMessage) {
        if (useChatStore.getState().streamingMessages[sessionId] === resumedAssistantMessageId) {
          setStreamingMessageIdWithSync(sessionId, null)
        }
        const hasOtherRunning = Object.values(useAgentStore.getState().runningSessions).some(
          (status) => status === 'running' || status === 'retrying'
        )
        if (!hasOtherRunning) {
          useAgentStore.getState().setRunning(false)
        }
      }
    }
  }, [sendMessage])

  const retryLastMessage = useCallback(
    async (assistantMessageId?: string) => {
      stopStreaming()
      const chatStore = useChatStore.getState()
      const sessionId = chatStore.activeSessionId
      if (!sessionId) return

      clearPendingSessionMessages(sessionId)
      const { target } = await resolveSessionMessageTarget(chatStore, sessionId, (messages) =>
        assistantMessageId
          ? findRetryAssistantTarget(messages, assistantMessageId)
          : (() => {
              const lastEditable = findLastEditableUserMessage(messages)
              if (!lastEditable) return null
              const assistantIndex = messages.findLastIndex((message, index) => {
                if (index <= lastEditable.index) return false
                return message.role === 'assistant'
              })
              if (assistantIndex < 0) return null
              return {
                assistantIndex,
                userIndex: lastEditable.index,
                draft: lastEditable.draft
              }
            })()
      )
      if (!target) return

      chatStore.truncateMessagesFrom(sessionId, target.userIndex)
      // The store method fires the DB truncation asynchronously.  Await the
      // same IPC call so sendMessage's loadRecentSessionMessages reads the
      // updated DB state instead of reloading the old (possibly empty)
      // assistant message that was just removed from the in-memory store.
      await invokeMessagePack(DB_MESSAGES_TRUNCATE_FROM_MSGPACK_CHANNEL, {
        sessionId,
        workspaceId:
          chatStore.sessions.find((session) => session.id === sessionId)?.workspaceId ??
          'local-personal',
        fromSortOrder: target.userIndex
      }).catch(() => {})
      await sendMessage(
        target.draft.text,
        target.draft.images.length > 0 ? cloneImageAttachments(target.draft.images) : undefined,
        undefined,
        undefined,
        target.draft.command
      )
    },
    [sendMessage, stopStreaming]
  )

  const editAndResend = useCallback(
    async (messageId: string, draft: EditableUserMessageDraft) => {
      stopStreaming()
      const chatStore = useChatStore.getState()
      const sessionId = chatStore.activeSessionId
      if (!sessionId) return

      clearPendingSessionMessages(sessionId)
      const { target } = await resolveSessionMessageTarget(chatStore, sessionId, (messages) =>
        findEditableUserMessageById(messages, messageId)
      )
      if (!target) return

      const nextDraft: EditableUserMessageDraft = {
        text: draft.text.trim(),
        images: cloneImageAttachments(draft.images),
        command: draft.command
      }
      if (!hasEditableDraftContent(nextDraft)) return

      chatStore.truncateMessagesFrom(sessionId, target.index)
      await invokeMessagePack(DB_MESSAGES_TRUNCATE_FROM_MSGPACK_CHANNEL, {
        sessionId,
        workspaceId:
          chatStore.sessions.find((session) => session.id === sessionId)?.workspaceId ??
          'local-personal',
        fromSortOrder: target.index
      }).catch(() => {})
      await sendMessage(
        nextDraft.text,
        nextDraft.images.length > 0 ? nextDraft.images : undefined,
        undefined,
        undefined,
        nextDraft.command
      )
    },
    [sendMessage, stopStreaming]
  )

  const deleteMessage = useCallback(
    async (messageId: string) => {
      stopStreaming()
      const chatStore = useChatStore.getState()
      const sessionId = chatStore.activeSessionId
      if (!sessionId) return

      clearPendingSessionMessages(sessionId)
      const { messages, target: nextMessages } = await resolveSessionMessageTarget(
        chatStore,
        sessionId,
        (messages) => buildDeletedMessages(messages, messageId)
      )
      if (!nextMessages || nextMessages.length === messages.length) return

      if (nextMessages.length === 0) {
        await chatStore.clearSessionMessages(sessionId)
        return
      }

      chatStore.replaceSessionMessages(sessionId, nextMessages)
    },
    [stopStreaming]
  )

  const previewContextCompressionAt = useCallback(
    async (messageId: string): Promise<ContextCompressionPreview | null> => {
      await ensureTokenEncoder()
      const chatStore = useChatStore.getState()
      const agentStore = useAgentStore.getState()
      const sessionId = chatStore.activeSessionId
      if (!sessionId || agentStore.runningSessions[sessionId]) return null

      const fullMessages = await chatStore.getFullSessionMessagesForMutation(sessionId)
      const targetIndex = fullMessages.findIndex((message) => message.id === messageId)
      if (targetIndex < 0) return null

      // “Compress to here” includes the selected message. The summary is then
      // displayed immediately after it, so choosing the final message places the
      // card at the bottom of the transcript.
      const messages = fullMessages.slice(0, targetIndex + 1)
      const settings = useSettingsStore.getState()
      const providerStore = useProviderStore.getState()
      const activeProvider = providerStore.getActiveProvider()
      if (activeProvider && !(await ensureProviderAuthReady(activeProvider.id))) return null

      const providerConfig = providerStore.getActiveProviderConfig()
      if (!providerConfig) return null

      const config: ProviderConfig = {
        ...providerConfig,
        sessionId,
        maxTokens: providerStore.getEffectiveMaxTokens(settings.maxTokens),
        temperature: settings.temperature,
        systemPrompt: settings.systemPrompt || undefined
      }
      const session = chatStore.sessions.find((item) => item.id === sessionId)
      if (session?.providerId && session?.modelId) {
        if (!(await ensureProviderAuthReady(session.providerId))) return null
        const sessionProviderConfig = providerStore.getProviderConfigById(
          session.providerId,
          session.modelId
        )
        if (!sessionProviderConfig) return null
        Object.assign(config, sessionProviderConfig, { sessionId })
      }

      const preTokens = estimateManualCompressionInputTokens(messages, config)
      const compacted = await compressWithCompactHooks(
        {
          sessionId,
          ...(session?.workingFolder ? { projectPath: session.workingFolder } : {}),
          messages,
          config,
          preTokens,
          trigger: 'manual'
        },
        emitHooks
      )
      if (!compacted) return null
      const { messages: compressed, result } = compacted
      const summaryMessage = compressed.find(isCompactSummaryMessage)
      const summary = summaryMessage ? getCompactSummaryDisplayText(summaryMessage).trim() : ''
      if (!result.compressed || !summary) return null

      return {
        sessionId,
        targetMessageId: messageId,
        sourceSnapshot: JSON.stringify(messages),
        compressedMessages: compressed,
        messagesSummarized: result.messagesSummarized ?? 0,
        summary
      }
    },
    []
  )

  const applyContextCompressionPreview = useCallback(
    async (preview: ContextCompressionPreview): Promise<ManualCompressionResult> => {
      const chatStore = useChatStore.getState()
      const agentStore = useAgentStore.getState()
      const sessionId = chatStore.activeSessionId
      if (!sessionId || sessionId !== preview.sessionId || agentStore.runningSessions[sessionId]) {
        return 'blocked'
      }

      const currentMessages = await chatStore.getFullSessionMessagesForMutation(sessionId)
      const targetIndex = currentMessages.findIndex(
        (message) => message.id === preview.targetMessageId
      )
      if (targetIndex < 0) return 'failed'
      if (JSON.stringify(currentMessages.slice(0, targetIndex + 1)) !== preview.sourceSnapshot) {
        return 'blocked'
      }

      const nextMessageId = currentMessages[targetIndex + 1]?.id
      const merged = await mergeCompressedMessagesIntoSession({
        sessionId,
        compressedMessages: preview.compressedMessages,
        currentMessages,
        ...(nextMessageId ? { insertBeforeIds: [nextMessageId] } : { insertAtEnd: true })
      })
      return merged ? 'compressed' : 'failed'
    },
    []
  )

  const manualCompressContext = useCallback(async (focusPrompt?: string) => {
    await ensureTokenEncoder()
    const compressionToastId = 'manual-context-compression'
    toast.dismiss(compressionToastId)
    const chatStore = useChatStore.getState()
    const agentStore = useAgentStore.getState()
    const sessionId = chatStore.activeSessionId
    if (!sessionId) {
      toast.error(i18n.t('context.compression.blockedTitle', { ns: 'cowork' }), {
        id: compressionToastId,
        description: i18n.t('context.compression.noSession', { ns: 'cowork' })
      })
      return 'blocked'
    }
    // Limitation 1: agent must not be running
    const sessionStatus = agentStore.runningSessions[sessionId]
    if (sessionStatus === 'running' || sessionStatus === 'retrying') {
      toast.error(i18n.t('context.compression.blockedTitle', { ns: 'cowork' }), {
        id: compressionToastId,
        description: i18n.t('context.compression.agentRunning', { ns: 'cowork' })
      })
      return 'blocked'
    }

    const messages = await chatStore.getSessionMessagesForRequest(sessionId, {
      requestContextMaxMessages: null,
      includeTrailingAssistantPlaceholder: false
    })
    if (messages.length === 0) {
      toast.error(i18n.t('context.compression.blockedTitle', { ns: 'cowork' }), {
        id: compressionToastId,
        description: i18n.t('context.compression.noMessages', { ns: 'cowork' })
      })
      return 'blocked'
    }

    // Build provider config (same as sendMessage)
    const settings = useSettingsStore.getState()
    const providerStore = useProviderStore.getState()
    const activeProvider = providerStore.getActiveProvider()
    if (activeProvider) {
      const ready = await ensureProviderAuthReady(activeProvider.id)
      if (!ready) {
        toast.error(i18n.t('context.compression.authMissingTitle', { ns: 'cowork' }), {
          id: compressionToastId,
          description: i18n.t('context.compression.providerLogin', { ns: 'cowork' })
        })
        return 'blocked'
      }
    }

    const providerConfig = providerStore.getActiveProviderConfig()
    const effectiveMaxTokens = providerStore.getEffectiveMaxTokens(settings.maxTokens)
    const activeModelConfig = providerStore.getActiveModelConfig()
    const activeModelThinkingConfig = activeModelConfig?.thinkingConfig
    const thinkingEnabled = settings.thinkingEnabled && !!activeModelThinkingConfig
    const reasoningEffort = resolveReasoningEffortForModel({
      reasoningEffort: settings.reasoningEffort,
      reasoningEffortByModel: settings.reasoningEffortByModel,
      providerId: providerConfig?.providerId,
      modelId: activeModelConfig?.id ?? providerConfig?.model,
      thinkingConfig: activeModelThinkingConfig
    })

    const config: ProviderConfig | null = providerConfig
      ? {
          ...providerConfig,
          sessionId,
          maxTokens: effectiveMaxTokens,
          temperature: settings.temperature,
          systemPrompt: settings.systemPrompt || undefined,
          thinkingEnabled,
          thinkingConfig: activeModelThinkingConfig,
          reasoningEffort
        }
      : null

    if (!config) {
      toast.error(i18n.t('context.compression.blockedTitle', { ns: 'cowork' }), {
        id: compressionToastId,
        description: i18n.t('context.compression.providerMissing', { ns: 'cowork' })
      })
      return 'blocked'
    }

    // Override with session-bound provider if available
    const compressSession = chatStore.sessions.find((s) => s.id === sessionId)
    if (compressSession?.providerId && compressSession?.modelId) {
      const ready = await ensureProviderAuthReady(compressSession.providerId)
      if (!ready) {
        toast.error(i18n.t('context.compression.authMissingTitle', { ns: 'cowork' }), {
          id: compressionToastId,
          description: i18n.t('context.compression.sessionProviderLogin', { ns: 'cowork' })
        })
        return 'blocked'
      }
      const sessionProviderConfig = providerStore.getProviderConfigById(
        compressSession.providerId,
        compressSession.modelId
      )
      if (!sessionProviderConfig) {
        toast.error(i18n.t('context.compression.blockedTitle', { ns: 'cowork' }), {
          id: compressionToastId,
          description: i18n.t('context.compression.sessionProviderMissing', { ns: 'cowork' })
        })
        return 'blocked'
      }
      Object.assign(config, sessionProviderConfig, { sessionId })
    }

    try {
      const preTokens = estimateManualCompressionInputTokens(messages, config)
      const compacted = await compressWithCompactHooks(
        {
          sessionId,
          ...(compressSession?.workingFolder ? { projectPath: compressSession.workingFolder } : {}),
          messages,
          config,
          preTokens,
          trigger: 'manual',
          focusPrompt: focusPrompt || undefined
        },
        emitHooks
      )
      if (!compacted) {
        toast.error(i18n.t('context.compression.blockedTitle', { ns: 'cowork' }), {
          id: compressionToastId,
          description: i18n.t('context.compression.hookBlocked', { ns: 'cowork' })
        })
        return 'blocked'
      }
      const { messages: compressed, result } = compacted
      if (!result.compressed) {
        toast.warning(i18n.t('context.compression.skippedTitle', { ns: 'cowork' }), {
          id: compressionToastId,
          description: i18n.t('context.compression.noCompressible', { ns: 'cowork' })
        })
        return 'skipped'
      }
      const merged = await mergeCompressedMessagesIntoSession({
        sessionId,
        compressedMessages: compressed
      })
      if (!merged) {
        toast.error(i18n.t('context.compression.failedTitle', { ns: 'cowork' }), {
          id: compressionToastId,
          description: i18n.t('context.compression.mergeFailed', { ns: 'cowork' })
        })
        return 'failed'
      }
      return 'compressed'
    } catch (err) {
      console.error('[Manual Compress Error]', err)
      toast.error(i18n.t('context.compression.failedTitle', { ns: 'cowork' }), {
        id: compressionToastId,
        description: i18n.t('context.compression.unexpectedFailure', { ns: 'cowork' })
      })
      return 'failed'
    }
  }, [])

  return {
    sendMessage,
    stopStreaming,
    continueLastToolExecution,
    retryLastMessage,
    editAndResend,
    deleteMessage,
    manualCompressContext,
    previewContextCompressionAt,
    applyContextCompressionPreview
  }
}

/**
 * Trigger sendMessage from outside the hook (e.g. plugin auto-reply).
 * Must be called after useChatActions has mounted at least once.
 */
export function triggerSendMessage(
  text: string,
  targetSessionId: string,
  images?: ImageAttachment[]
): void {
  const sendMessageHandler = getSendMessageHandler()
  if (!sendMessageHandler) {
    console.error('[triggerSendMessage] sendMessage not initialized yet')
    return
  }
  void sendMessageHandler(text, images, undefined, targetSessionId)
}

/** Start a user-selected business task in its owning session with a durable run link. */
export function triggerBusinessTaskRun(
  text: string,
  sessionId: string,
  businessTaskId: string
): Promise<void> {
  const sendMessage = getSendMessageHandler()
  if (!sendMessage) return Promise.reject(new Error('CHAT_ACTIONS_UNAVAILABLE'))
  return sendMessage(text, undefined, undefined, sessionId, undefined, undefined, {
    businessTaskId
  })
}
