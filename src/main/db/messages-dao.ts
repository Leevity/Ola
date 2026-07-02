import { getNativeWorker } from '../lib/native-worker'

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

export interface MessageInput {
  id: string
  sessionId: string
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

export function getMessages(sessionId: string): Promise<MessageRow[]> {
  return getNativeWorker().request<MessageRow[]>('db/messages-list', { sessionId }, 120_000)
}

export function getUserMessages(sessionId: string): Promise<MessageRow[]> {
  return getNativeWorker().request<MessageRow[]>('db/messages-list-user', { sessionId }, 120_000)
}

export function getMessagesPage(
  sessionId: string,
  limit: number,
  offset: number
): Promise<MessageRow[]> {
  return getNativeWorker().request<MessageRow[]>(
    'db/messages-list-page',
    { sessionId, limit, offset },
    120_000
  )
}

export function getMessagesRequestContext(args: {
  sessionId: string
  maxMessages: number
  headLimit?: number
}): Promise<MessageRow[]> {
  return getNativeWorker().request<MessageRow[]>('db/messages-request-context', args, 120_000)
}

export function getMessagesWindowAround(args: {
  sessionId: string
  messageId?: string | null
  sortOrder?: number | null
  limit: number
}): Promise<MessageWindowResult> {
  return getNativeWorker().request<MessageWindowResult>('db/messages-window-around', args, 120_000)
}

export async function insertMessageArtifacts(args: {
  sessionId: string
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
  await requestMutation('db/messages-add', msg)
}

export async function addMessages(msgs: MessageInput[]): Promise<void> {
  if (msgs.length === 0) return
  await requestMutation('db/messages-add-batch', { messages: msgs })
}

export async function upsertMessage(msg: MessageInput): Promise<void> {
  await requestMutation('db/messages-upsert', msg)
}

export async function updateMessage(
  msgId: string,
  patch: Partial<{ content: string; meta: string | null; usage: string | null }>
): Promise<void> {
  await requestMutation('db/messages-update', { id: msgId, patch })
}

export async function clearMessages(sessionId: string): Promise<void> {
  await requestMutation('db/messages-clear', { sessionId })
}

export async function deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
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
  }>
): Promise<void> {
  await requestMutation('db/messages-replace', { sessionId, messages })
}

export async function truncateMessagesFrom(
  sessionId: string,
  fromSortOrder: number
): Promise<void> {
  await requestMutation('db/messages-truncate-from', { sessionId, fromSortOrder })
}

export async function deleteLastMessage(
  sessionId: string,
  role: string
): Promise<MessageRow | null> {
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

export async function getMessageCount(sessionId: string): Promise<number> {
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

export function searchMessageContent(query: string, limit = 50): Promise<MessageContentMatch[]> {
  return getNativeWorker().request<MessageContentMatch[]>(
    'db/messages-search-content',
    { query, limit },
    120_000
  )
}
