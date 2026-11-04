import { nanoid } from 'nanoid'
import { toast } from 'sonner'
import i18n from '@renderer/locales'
import {
  awaitPendingSessionCreate,
  hasPendingSessionCreateFailure,
  useChatStore
} from '@renderer/stores/chat-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { recoverPendingSessionQueue } from '@renderer/lib/workbench/pending-session-queue'
import {
  cloneImageAttachments,
  type EditableUserMessageDraft,
  type ImageAttachment
} from '@renderer/lib/image-attachments'
import type { SystemCommandSnapshot } from '@renderer/lib/commands/system-command'
import type { MessageSource, SendMessageOptions } from '@renderer/hooks/send-message-options'

export type PendingSessionDispatchMode = 'after_loop' | 'interrupt_next'

export interface QueuedSessionMessage {
  id: string
  text: string
  images?: ImageAttachment[]
  command?: SystemCommandSnapshot | null
  source?: MessageSource
  options?: SendMessageOptions
  dispatchMode?: PendingSessionDispatchMode
  recoveryState?: 'dispatching' | 'needs_review'
  createdAt: number
}

/** Per-session pending user sends while the agent is already running. */
const pendingSessionMessages = new Map<string, QueuedSessionMessage[]>()
const pendingSessionMessageViews = new Map<string, PendingSessionMessageItem[]>()
const pendingSessionMessageListeners = new Set<() => void>()
const pausedPendingSessionDispatch = new Set<string>()
const pendingQueueHydrationPromises = new Map<string, Promise<void>>()
const hydratedPendingQueueSessions = new Set<string>()
const pendingQueuePersistence = new Map<string, Promise<void>>()
const pendingQueuePersistenceErrorNotified = new Set<string>()
const pendingDispatchingMessages = new Map<string, QueuedSessionMessage>()
export const MAX_PENDING_SESSION_MESSAGES = 50

export interface PendingSessionMessageItem {
  id: string
  text: string
  images: ImageAttachment[]
  command: SystemCommandSnapshot | null
  createdAt: number
  recoveryState?: 'dispatching' | 'needs_review'
}

const EMPTY_PENDING_SESSION_MESSAGES: PendingSessionMessageItem[] = []

function cloneOptionalImageAttachments(images?: ImageAttachment[]): ImageAttachment[] | undefined {
  const cloned = cloneImageAttachments(images)
  return cloned.length > 0 ? cloned : undefined
}

function toPendingItem(msg: QueuedSessionMessage): PendingSessionMessageItem {
  return {
    id: msg.id,
    text: msg.text,
    images: cloneImageAttachments(msg.images),
    command: msg.command ?? null,
    createdAt: msg.createdAt,
    recoveryState: msg.recoveryState
  }
}

function notifyPendingSessionMessageListeners(): void {
  for (const listener of pendingSessionMessageListeners) {
    listener()
  }
}

function isHiddenFromQueueView(msg: QueuedSessionMessage): boolean {
  // Quoted messages are already rendered; keep their process-only queue entry hidden.
  return !!msg.options?.preRenderedUserMessageId
}

function updateQueuedGoalObjectiveOption(
  options: SendMessageOptions | undefined,
  text: string
): SendMessageOptions | undefined {
  if (!options) return options

  let next: SendMessageOptions = options
  if (options.goalObjective !== undefined) {
    next = { ...next }
    const objective = text.trim()
    if (objective) {
      next.goalObjective = objective
    } else {
      delete next.goalObjective
    }
  }

  if (next.selectedFileReferences) {
    next = { ...next }
    delete next.selectedFileReferences
  }

  return next
}

function persistPendingSessionQueue(sessionId: string, messages: QueuedSessionMessage[]): void {
  const session = useChatStore.getState().sessions.find((item) => item.id === sessionId)
  if (!session) return
  const workspaceId = session.workspaceId ?? 'local-personal'
  const previous = pendingQueuePersistence.get(sessionId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await ipcClient.invoke(IPC.DB_PENDING_SESSION_QUEUE_REPLACE, {
        sessionId,
        workspaceId,
        messages: [
          ...(pendingDispatchingMessages.has(sessionId)
            ? [pendingDispatchingMessages.get(sessionId)!]
            : []),
          ...messages
        ]
      })
      pendingQueuePersistenceErrorNotified.delete(sessionId)
    })
    .catch((error: unknown) => {
      console.error('[SessionQueue] Failed to persist queued messages:', error)
      if (pendingQueuePersistenceErrorNotified.has(sessionId)) return
      pendingQueuePersistenceErrorNotified.add(sessionId)
      toast.error(
        i18n.t('chat:pendingQueue.persistFailed', {
          defaultValue: 'Queued messages could not be saved. Keep Ola open and try again.'
        })
      )
    })
  pendingQueuePersistence.set(sessionId, next)
}

export function hydratePendingSessionQueue(sessionId: string): Promise<void> {
  if (hydratedPendingQueueSessions.has(sessionId)) return Promise.resolve()
  const existing = pendingQueueHydrationPromises.get(sessionId)
  if (existing) return existing
  const session = useChatStore.getState().sessions.find((item) => item.id === sessionId)
  if (!session) return Promise.resolve()
  const workspaceId = session.workspaceId ?? 'local-personal'

  const hydration = (async () => {
    try {
      await awaitPendingSessionCreate(sessionId)
    } catch (error) {
      // A newly created local session has no stored queue when its row fails
      // to commit. The send flow owns the creation error and draft recovery.
      if (hasPendingSessionCreateFailure(sessionId)) return
      throw error
    }
    const result = await ipcClient.invoke(IPC.DB_PENDING_SESSION_QUEUE_GET, {
      sessionId,
      workspaceId
    })
    const current = pendingSessionMessages.get(sessionId) ?? []
    const recovered = Array.isArray(result) ? result : []
    const merged = recoverPendingSessionQueue<QueuedSessionMessage>(
      result,
      current,
      MAX_PENDING_SESSION_MESSAGES + 1
    )
    hydratedPendingQueueSessions.add(sessionId)
    if (merged.length > 0) {
      pendingSessionMessages.set(sessionId, merged)
      pendingSessionMessageViews.set(
        sessionId,
        merged.filter((message) => !isHiddenFromQueueView(message)).map(toPendingItem)
      )
      persistPendingSessionQueue(sessionId, merged)
    }
    if (recovered.length > 0) {
      setPendingSessionDispatchPaused(sessionId, true)
    }
    notifyPendingSessionMessageListeners()
  })()
    .catch((error: unknown) => {
      console.error('[SessionQueue] Failed to restore queued messages:', error)
      toast.error(
        i18n.t('chat:pendingQueue.restoreFailed', {
          defaultValue: 'Queued messages could not be restored.'
        })
      )
    })
    .finally(() => pendingQueueHydrationPromises.delete(sessionId))
  pendingQueueHydrationPromises.set(sessionId, hydration)
  return hydration
}

export async function flushPendingSessionQueue(sessionId: string): Promise<void> {
  await pendingQueuePersistence.get(sessionId)
  if (pendingQueuePersistenceErrorNotified.has(sessionId)) {
    throw new Error('PENDING_SESSION_QUEUE_PERSIST_FAILED')
  }
}

export function setPendingSessionDispatchPaused(sessionId: string, paused: boolean): void {
  const changed = paused
    ? !pausedPendingSessionDispatch.has(sessionId)
    : pausedPendingSessionDispatch.has(sessionId)
  if (!changed) return

  if (paused) {
    pausedPendingSessionDispatch.add(sessionId)
  } else {
    pausedPendingSessionDispatch.delete(sessionId)
  }
  notifyPendingSessionMessageListeners()
}

export function replaceSessionPendingMessages(
  sessionId: string,
  next: QueuedSessionMessage[],
  persist = true
): void {
  if (next.length === 0) {
    pendingSessionMessages.delete(sessionId)
    pendingSessionMessageViews.delete(sessionId)
    pausedPendingSessionDispatch.delete(sessionId)
  } else {
    pendingSessionMessages.set(sessionId, next)
    const views = next.filter((msg) => !isHiddenFromQueueView(msg)).map(toPendingItem)
    if (views.length === 0) {
      pendingSessionMessageViews.delete(sessionId)
    } else {
      pendingSessionMessageViews.set(sessionId, views)
    }
  }
  if (persist && hydratedPendingQueueSessions.has(sessionId))
    persistPendingSessionQueue(sessionId, next)
  notifyPendingSessionMessageListeners()
}

export function subscribePendingSessionMessages(listener: () => void): () => void {
  pendingSessionMessageListeners.add(listener)
  return () => {
    pendingSessionMessageListeners.delete(listener)
  }
}

export function getPendingSessionMessages(sessionId: string): PendingSessionMessageItem[] {
  return pendingSessionMessageViews.get(sessionId) ?? EMPTY_PENDING_SESSION_MESSAGES
}

export function getPendingSessionMessageCountForSession(sessionId: string): number {
  return pendingSessionMessages.get(sessionId)?.length ?? 0
}

export function isPendingSessionDispatchPaused(sessionId: string): boolean {
  return pausedPendingSessionDispatch.has(sessionId)
}

export function clearPendingSessionMessages(sessionId: string): number {
  const cleared = pendingSessionMessages.get(sessionId)?.length ?? 0
  if (cleared === 0) {
    setPendingSessionDispatchPaused(sessionId, false)
    return 0
  }
  replaceSessionPendingMessages(sessionId, [])
  return cleared
}

export function updatePendingSessionMessageDraft(
  sessionId: string,
  messageId: string,
  draft: EditableUserMessageDraft
): boolean {
  const queue = pendingSessionMessages.get(sessionId)
  if (!queue || queue.length === 0) return false
  let changed = false
  const next = queue.map((msg) => {
    if (msg.id !== messageId) return msg
    changed = true
    return {
      ...msg,
      text: draft.text,
      images: cloneOptionalImageAttachments(draft.images),
      command: draft.command,
      options: updateQueuedGoalObjectiveOption(msg.options, draft.text)
    }
  })
  if (!changed) return false
  replaceSessionPendingMessages(sessionId, next)
  return true
}

export function removePendingSessionMessage(sessionId: string, messageId: string): boolean {
  const queue = pendingSessionMessages.get(sessionId)
  if (!queue || queue.length === 0) return false
  const next = queue.filter((msg) => msg.id !== messageId)
  if (next.length === queue.length) return false
  replaceSessionPendingMessages(sessionId, next)
  return true
}

export function enqueuePendingSessionMessage(
  sessionId: string,
  msg: Omit<QueuedSessionMessage, 'id' | 'createdAt'>
): number | null {
  const queue = pendingSessionMessages.get(sessionId) ?? []
  if (queue.length >= MAX_PENDING_SESSION_MESSAGES) return null
  const next = [
    ...queue,
    {
      id: nanoid(),
      createdAt: Date.now(),
      text: msg.text,
      images: cloneOptionalImageAttachments(msg.images),
      command: msg.command ?? null,
      source: msg.source,
      options: msg.options ? { ...msg.options } : undefined,
      dispatchMode: msg.dispatchMode ?? 'after_loop'
    }
  ]
  replaceSessionPendingMessages(sessionId, next)
  return next.length
}

export function dequeuePendingSessionMessage(sessionId: string): QueuedSessionMessage | null {
  const queue = pendingSessionMessages.get(sessionId)
  if (!queue || queue.length === 0) return null
  const [head, ...rest] = queue
  replaceSessionPendingMessages(sessionId, rest, false)
  return {
    ...head,
    text: head.text,
    images: cloneOptionalImageAttachments(head.images),
    command: head.command ?? null,
    options: head.options ? { ...head.options } : undefined,
    dispatchMode: head.dispatchMode ?? 'after_loop'
  }
}

export function hasPendingSessionMessages(sessionId: string): boolean {
  const queue = pendingSessionMessages.get(sessionId)
  return !!queue && queue.length > 0
}

export function hasImmediatePendingSessionMessage(sessionId: string): boolean {
  return (
    pendingSessionMessages.get(sessionId)?.some((msg) => msg.dispatchMode === 'interrupt_next') ??
    false
  )
}

export function hasPendingSessionMessagesForSession(sessionId: string): boolean {
  return hasPendingSessionMessages(sessionId)
}

/** Read the queue head for dispatch without mutating state. */
export function peekNextQueuedSessionMessage(sessionId: string): QueuedSessionMessage | null {
  return pendingSessionMessages.get(sessionId)?.[0] ?? null
}

/** Track the in-flight dispatch so a crash mid-send can be recovered as `needs_review`. */
export function markQueuedSessionMessageDispatching(
  sessionId: string,
  message: QueuedSessionMessage
): void {
  pendingDispatchingMessages.set(sessionId, { ...message, recoveryState: 'dispatching' })
  if (hydratedPendingQueueSessions.has(sessionId))
    persistPendingSessionQueue(sessionId, pendingSessionMessages.get(sessionId) ?? [])
}

export function clearDispatchingSessionMessage(sessionId: string): void {
  pendingDispatchingMessages.delete(sessionId)
}

export function isPendingSessionQueueHydrated(sessionId: string): boolean {
  return hydratedPendingQueueSessions.has(sessionId)
}

export function persistCurrentPendingSessionQueue(sessionId: string): void {
  persistPendingSessionQueue(sessionId, pendingSessionMessages.get(sessionId) ?? [])
}

export function getQueuedSessionMessages(sessionId: string): QueuedSessionMessage[] {
  return pendingSessionMessages.get(sessionId) ?? []
}

// Drop per-session queue state when the session is deleted, so the module-level
// Maps cannot grow without bound.
let knownSessionIds: Set<string> | null = null
useChatStore.subscribe((state) => {
  const currentIds = new Set(state.sessions.map((s) => s.id))
  if (knownSessionIds) {
    for (const id of knownSessionIds) {
      if (currentIds.has(id)) continue
      pendingSessionMessages.delete(id)
      pendingSessionMessageViews.delete(id)
      pausedPendingSessionDispatch.delete(id)
      pendingQueueHydrationPromises.delete(id)
      pendingQueuePersistence.delete(id)
      pendingQueuePersistenceErrorNotified.delete(id)
      pendingDispatchingMessages.delete(id)
      hydratedPendingQueueSessions.delete(id)
    }
  }
  knownSessionIds = currentIds
})
