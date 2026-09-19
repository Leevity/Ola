import { getNativeWorker } from '../lib/native-worker'
import {
  canaryListMessageLocatorRows,
  canaryListMessageMarkers,
  canaryListMessages,
  canaryListMessagesPage,
  canaryListUserMessages,
  canaryGetMessageCount,
  canaryGetMessagesRequestContext,
  canaryGetMessagesWindowAround,
  canarySearchMessageContent
} from './legacy-read-canary'
import { businessWriteCanary } from './business-write-canary'

export interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  meta: string | null
  created_at: number
  usage: string | null
  sort_order: number
}

export interface MessageLocatorRow {
  id: string
  session_id: string
  role: string
  content: string
  meta: string | null
  created_at: number
  sort_order: number
}

export interface MessageInput {
  id: string
  sessionId: string
  /** Required ownership scope; the Worker must never infer this from UI state. */
  workspaceId: string
  role: string
  content: string
  meta?: string | null
  createdAt: number
  usage?: string | null
  sortOrder: number
  debugReason?: string | null
}

export interface MessageContentMatch {
  session_id: string
  snippet: string
}

export interface MessageWindowResult {
  success: boolean
  rows: MessageRow[]
  start: number
  end: number
  total: number
  anchorSortOrder: number
  error?: string | null
}

export interface MessageInsertArtifactsResult {
  success: boolean
  inserted: number
  start: number
  end: number
  total: number
  error?: string | null
}

interface MessageMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

interface MessageDeleteResult {
  success: boolean
  deleted: boolean
  error?: string | null
}

interface MessageCountResult {
  success: boolean
  count: number
  error?: string | null
}

interface MessageDeleteLastResult {
  success: boolean
  message?: MessageRow | null
  error?: string | null
}

async function requestMutation(method: string, params: object): Promise<MessageMutationResult> {
  const result = await getNativeWorker().request<MessageMutationResult>(method, params, 120_000)
  if (!result.success) {
    throw new Error(result.error || `Native message mutation failed: ${method}`)
  }
  return result
}

export async function getMessages(sessionId: string, workspaceId?: string): Promise<MessageRow[]> {
  const migrated = await canaryListMessages(sessionId, workspaceId)
  if (migrated !== undefined) return migrated
  return getNativeWorker().request<MessageRow[]>('db/messages-list', { sessionId }, 120_000)
}

export async function getUserMessages(
  sessionId: string,
  workspaceId?: string
): Promise<MessageRow[]> {
  const migrated = await canaryListUserMessages(sessionId, workspaceId)
  if (migrated !== undefined) return migrated
  return getNativeWorker().request<MessageRow[]>('db/messages-list-user', { sessionId }, 120_000)
}

export async function getMessageMarkers(
  sessionId: string,
  workspaceId?: string
): Promise<MessageRow[]> {
  const migrated = await canaryListMessageMarkers(sessionId, workspaceId)
  if (migrated !== undefined) return migrated
  return getNativeWorker().request<MessageRow[]>('db/messages-list-markers', { sessionId }, 120_000)
}

export async function getMessageLocatorRows(
  sessionId: string,
  workspaceId?: string
): Promise<MessageLocatorRow[]> {
  const migrated = await canaryListMessageLocatorRows(sessionId, workspaceId)
  if (migrated !== undefined) return migrated
  return getNativeWorker().request<MessageLocatorRow[]>(
    'db/messages-list-locator',
    { sessionId },
    120_000
  )
}

export async function getMessagesPage(
  sessionId: string,
  limit: number,
  offset: number,
  workspaceId?: string
): Promise<MessageRow[]> {
  const migrated = await canaryListMessagesPage(sessionId, workspaceId, limit, offset)
  if (migrated !== undefined) return migrated
  return getNativeWorker().request<MessageRow[]>(
    'db/messages-list-page',
    { sessionId, limit, offset },
    120_000
  )
}

export async function getMessagesRequestContext(args: {
  sessionId: string
  workspaceId?: string
  maxMessages: number
  headLimit?: number
}): Promise<MessageRow[]> {
  const migrated = await canaryGetMessagesRequestContext(args)
  if (migrated !== undefined) return migrated
  return await getNativeWorker().request<MessageRow[]>('db/messages-request-context', args, 120_000)
}

export async function getMessagesWindowAround(args: {
  sessionId: string
  workspaceId?: string
  messageId?: string | null
  sortOrder?: number | null
  limit: number
}): Promise<MessageWindowResult> {
  const migrated = await canaryGetMessagesWindowAround(args)
  if (migrated !== undefined) return migrated
  return await getNativeWorker().request<MessageWindowResult>(
    'db/messages-window-around',
    args,
    120_000
  )
}

export async function insertMessageArtifacts(args: {
  sessionId: string
  workspaceId?: string
  insertSortOrder: number
  insertBeforeMessageId?: string | null
  messages: Array<{
    id: string
    role: string
    content: string
    meta?: string | null
    createdAt: number
    usage?: string | null
    sortOrder: number
  }>
}): Promise<MessageInsertArtifactsResult> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!args.workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    return writer.insertMessageArtifacts({
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      insertSortOrder: args.insertSortOrder,
      insertBeforeMessageId: args.insertBeforeMessageId,
      messages: args.messages
    })
  }
  const result = await getNativeWorker().request<MessageInsertArtifactsResult>(
    'db/messages-insert-artifacts',
    args,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native message artifact insert failed')
  }
  return result
}

export async function addMessage(msg: MessageInput): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.addMessage(msg)
    return
  }
  await requestMutation('db/messages-add', msg)
}

export async function addMessages(msgs: MessageInput[]): Promise<void> {
  if (msgs.length === 0) return
  const writer = businessWriteCanary()
  if (writer) {
    const workspaceId = msgs[0].workspaceId
    if (msgs.some((message) => message.workspaceId !== workspaceId)) {
      throw new Error('TS_BUSINESS_WORKSPACE_MISMATCH')
    }
    await writer.addMessages({ workspaceId, messages: msgs })
    return
  }
  await requestMutation('db/messages-add-batch', { messages: msgs })
}

export async function upsertMessage(msg: MessageInput): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.upsertMessage({ ...msg, updatedAt: Date.now() })
    return
  }
  await requestMutation('db/messages-upsert', msg)
}

export async function updateMessage(
  msgId: string,
  patch: Partial<{ content: string; meta: string | null; usage: string | null }>,
  workspaceId?: string
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.updateMessage({ id: msgId, workspaceId, patch })
    return
  }
  await requestMutation('db/messages-update', { id: msgId, patch })
}

export async function clearMessages(sessionId: string, workspaceId?: string): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.clearMessages(sessionId, workspaceId)
    return
  }
  await requestMutation('db/messages-clear', { sessionId })
}

export async function deleteMessage(
  sessionId: string,
  messageId: string,
  workspaceId?: string
): Promise<boolean> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    return writer.deleteMessage({ id: messageId, sessionId, workspaceId, updatedAt: Date.now() })
  }
  const result = await getNativeWorker().request<MessageDeleteResult>(
    'db/messages-delete',
    { sessionId, messageId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native message delete failed')
  }
  return result.deleted
}

export async function replaceMessages(
  sessionId: string,
  messages: Array<{
    id: string
    role: string
    content: string
    meta?: string | null
    createdAt: number
    usage?: string | null
    sortOrder: number
  }>,
  workspaceId?: string
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.replaceMessages({ sessionId, workspaceId, messages })
    return
  }
  await requestMutation('db/messages-replace', { sessionId, messages })
}

export async function truncateMessagesFrom(
  sessionId: string,
  fromSortOrder: number,
  workspaceId?: string
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.truncateMessagesFrom({ sessionId, workspaceId, fromSortOrder })
    return
  }
  await requestMutation('db/messages-truncate-from', { sessionId, fromSortOrder })
}

export async function deleteLastMessage(
  sessionId: string,
  role: string,
  workspaceId?: string
): Promise<MessageRow | null> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    return writer.deleteLastMessage<MessageRow>({ sessionId, workspaceId, role })
  }
  const result = await getNativeWorker().request<MessageDeleteLastResult>(
    'db/messages-delete-last',
    { sessionId, role },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native message delete-last failed')
  }
  return result.message ?? null
}

export async function getMessageCount(sessionId: string, workspaceId?: string): Promise<number> {
  const migrated = await canaryGetMessageCount(sessionId, workspaceId)
  if (migrated !== undefined) return migrated
  const result = await getNativeWorker().request<MessageCountResult>(
    'db/messages-count',
    { sessionId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native message count failed')
  }
  return result.count
}

export async function searchMessageContent(
  query: string,
  limit = 50,
  workspaceId?: string
): Promise<MessageContentMatch[]> {
  const migrated = await canarySearchMessageContent(query, workspaceId, limit)
  if (migrated !== undefined) return migrated
  return await getNativeWorker().request<MessageContentMatch[]>(
    'db/messages-search-content',
    { query, limit, workspaceId },
    120_000
  )
}
