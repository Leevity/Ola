import { ipcMain } from 'electron'
import { initializeDatabase } from '../db/database'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import { authorizeMessageSearchWorkspace } from './message-search-workspace'
import { authorizeDbWorkspace } from './db-workspace-authorization'
import * as sessionsDao from '../db/sessions-dao'
import * as projectsDao from '../db/projects-dao'
import * as messagesDao from '../db/messages-dao'
import * as plansDao from '../db/plans-dao'
import * as tasksDao from '../db/tasks-dao'
import * as goalsDao from '../db/goals-dao'
import * as drawRunsDao from '../db/draw-runs-dao'
import * as usageEventsDao from '../db/usage-events-dao'
import { getGoalRuntimeService } from '../goals/goal-runtime'
import { emitGoalCleared, emitGoalEventAdded, emitGoalUpdated } from '../goals/goal-sync'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
import {
  DB_DRAW_RUNS_CLEAR_MSGPACK_CHANNEL,
  DB_DRAW_RUNS_DELETE_MSGPACK_CHANNEL,
  DB_DRAW_RUNS_LIST_MSGPACK_CHANNEL,
  DB_DRAW_RUNS_SAVE_MSGPACK_CHANNEL,
  DB_GOALS_ACCOUNT_MSGPACK_CHANNEL,
  DB_GOALS_CLEAR_MSGPACK_CHANNEL,
  DB_GOALS_CREATE_MSGPACK_CHANNEL,
  DB_GOALS_GET_MSGPACK_CHANNEL,
  DB_GOALS_LIST_MSGPACK_CHANNEL,
  DB_GOALS_SET_MSGPACK_CHANNEL,
  DB_GOALS_UPDATE_MSGPACK_CHANNEL,
  DB_GOAL_EVENTS_ADD_MSGPACK_CHANNEL,
  DB_GOAL_EVENTS_LIST_MSGPACK_CHANNEL,
  DB_MESSAGES_ADD_BATCH_MSGPACK_CHANNEL,
  DB_MESSAGES_CLEAR_MSGPACK_CHANNEL,
  DB_MESSAGES_COUNT_MSGPACK_CHANNEL,
  DB_MESSAGES_DELETE_MSGPACK_CHANNEL,
  DB_MESSAGES_INSERT_ARTIFACTS_MSGPACK_CHANNEL,
  DB_MESSAGES_LIST_MSGPACK_CHANNEL,
  DB_MESSAGES_LIST_MARKERS_MSGPACK_CHANNEL,
  DB_MESSAGES_LIST_LOCATOR_MSGPACK_CHANNEL,
  DB_MESSAGES_LIST_PAGE_MSGPACK_CHANNEL,
  DB_MESSAGES_LIST_USER_MSGPACK_CHANNEL,
  DB_MESSAGES_REQUEST_CONTEXT_MSGPACK_CHANNEL,
  DB_MESSAGES_REPLACE_MSGPACK_CHANNEL,
  DB_MESSAGES_SEARCH_CONTENT_MSGPACK_CHANNEL,
  DB_MESSAGES_TRUNCATE_FROM_MSGPACK_CHANNEL,
  DB_MESSAGES_UPDATE_MSGPACK_CHANNEL,
  DB_MESSAGES_UPSERT_MSGPACK_CHANNEL,
  DB_MESSAGES_WINDOW_AROUND_MSGPACK_CHANNEL,
  DB_PLANS_CREATE_MSGPACK_CHANNEL,
  DB_PLANS_DELETE_MSGPACK_CHANNEL,
  DB_PLANS_GET_BY_SESSION_MSGPACK_CHANNEL,
  DB_PLANS_GET_MSGPACK_CHANNEL,
  DB_PLANS_LIST_MSGPACK_CHANNEL,
  DB_PLANS_UPDATE_MSGPACK_CHANNEL,
  DB_PROJECTS_CREATE_MSGPACK_CHANNEL,
  DB_PROJECTS_DELETE_MSGPACK_CHANNEL,
  DB_PROJECTS_ENSURE_DEFAULT_MSGPACK_CHANNEL,
  DB_PROJECTS_GET_MSGPACK_CHANNEL,
  DB_PROJECTS_LIST_MSGPACK_CHANNEL,
  DB_PROJECTS_UPDATE_MSGPACK_CHANNEL,
  DB_SESSIONS_CLEAR_ALL_MSGPACK_CHANNEL,
  DB_SESSIONS_CREATE_MSGPACK_CHANNEL,
  DB_SESSIONS_DELETE_MSGPACK_CHANNEL,
  DB_SESSIONS_GET_MSGPACK_CHANNEL,
  DB_SESSIONS_LIST_MSGPACK_CHANNEL,
  DB_SESSIONS_UPDATE_MSGPACK_CHANNEL,
  DB_TASKS_CREATE_MSGPACK_CHANNEL,
  DB_TASKS_DELETE_BY_SESSION_MSGPACK_CHANNEL,
  DB_TASKS_DELETE_MSGPACK_CHANNEL,
  DB_TASKS_GET_MSGPACK_CHANNEL,
  DB_TASKS_LIST_ALL_MSGPACK_CHANNEL,
  DB_TASKS_LIST_BY_SESSION_MSGPACK_CHANNEL,
  DB_TASKS_UPDATE_MSGPACK_CHANNEL,
  USAGE_ACTIVITY_BY_MODEL_MSGPACK_CHANNEL,
  USAGE_ACTIVITY_BY_PROVIDER_MSGPACK_CHANNEL,
  USAGE_ACTIVITY_DAILY_MSGPACK_CHANNEL,
  USAGE_ACTIVITY_OVERVIEW_MSGPACK_CHANNEL,
  USAGE_EVENTS_ADD_MSGPACK_CHANNEL,
  USAGE_EVENTS_BY_MODEL_MSGPACK_CHANNEL,
  USAGE_EVENTS_BY_PROVIDER_MSGPACK_CHANNEL,
  USAGE_EVENTS_CLEAR_MSGPACK_CHANNEL,
  USAGE_EVENTS_DAILY_MSGPACK_CHANNEL,
  USAGE_EVENTS_LIST_MSGPACK_CHANNEL,
  USAGE_EVENTS_OVERVIEW_MSGPACK_CHANNEL,
  USAGE_EVENTS_TIMELINE_MSGPACK_CHANNEL,
  decodeMessagePackPayload,
  encodeMessagePackPayload
} from '../../shared/messagepack/binary-ipc'

const CHAT_SESSION_UPDATED = 'chat:session-updated'
const CHAT_SESSION_DELETED = 'chat:session-deleted'
const MAX_GOAL_OBJECTIVE_CHARS = 4000
const DB_UPSERT_TRACE_WINDOW_MS = 30_000
const GOAL_EVENT_TYPES = new Set<goalsDao.SessionGoalEventType>([
  'created',
  'replaced',
  'objective_updated',
  'budget_updated',
  'status_changed',
  'usage_accounted',
  'usage_limited',
  'budget_limited',
  'completion_deferred',
  'blocked',
  'completed',
  'stall_paused',
  'auto_continue_blocked',
  'cleared'
])

interface RegisterDbHandlersOptions {
  onSessionDeleted?: (sessionId: string) => void
}

let dbUpsertTraceWindowStartedAt = Date.now()
let dbUpsertTraceTotal = 0
const dbUpsertTraceByReason = new Map<string, number>()
const dbUpsertTraceSessionIds = new Set<string>()

function isTruthyDebugFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

function shouldLogDbUpsertTrace(): boolean {
  return (
    isTruthyDebugFlag(process.env.OLA_DB_TRACE) || isTruthyDebugFlag(process.env.OLA_NATIVE_DEBUG)
  )
}

function recordDbUpsertTrace(msg: messagesDao.MessageInput): void {
  if (!shouldLogDbUpsertTrace()) return

  const reason = msg.debugReason?.trim() || 'unknown'
  dbUpsertTraceTotal += 1
  dbUpsertTraceByReason.set(reason, (dbUpsertTraceByReason.get(reason) ?? 0) + 1)
  dbUpsertTraceSessionIds.add(msg.sessionId)

  const now = Date.now()
  if (now - dbUpsertTraceWindowStartedAt < DB_UPSERT_TRACE_WINDOW_MS) return

  console.log('[DBTrace] db:messages:upsert summary', {
    windowMs: now - dbUpsertTraceWindowStartedAt,
    total: dbUpsertTraceTotal,
    byReason: Object.fromEntries(dbUpsertTraceByReason.entries()),
    sessionCount: dbUpsertTraceSessionIds.size,
    last: {
      reason,
      sessionId: msg.sessionId,
      messageId: msg.id,
      role: msg.role,
      sortOrder: msg.sortOrder
    }
  })

  dbUpsertTraceWindowStartedAt = now
  dbUpsertTraceTotal = 0
  dbUpsertTraceByReason.clear()
  dbUpsertTraceSessionIds.clear()
}

async function emitSessionUpdated(sessionId: string, reason: string): Promise<void> {
  const session = await sessionsDao.getSession(sessionId)
  if (!session) return

  safeSendMessagePackToAllWindows(CHAT_SESSION_UPDATED, {
    reason,
    session
  })
}

function emitSessionDeleted(
  sessionId: string,
  reason: string,
  options?: RegisterDbHandlersOptions
): void {
  options?.onSessionDeleted?.(sessionId)
  safeSendMessagePackToAllWindows(CHAT_SESSION_DELETED, {
    reason,
    sessionId
  })
}

function normalizeGoalObjective(value: unknown): string {
  const objective = typeof value === 'string' ? value.trim() : ''
  if (!objective) {
    throw new Error('goal objective must not be empty')
  }
  if ([...objective].length > MAX_GOAL_OBJECTIVE_CHARS) {
    throw new Error(`goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters`)
  }
  return objective
}

function normalizeGoalStatus(value: unknown): goalsDao.SessionGoalStatus | undefined {
  if (
    value === 'active' ||
    value === 'paused' ||
    value === 'blocked' ||
    value === 'usage_limited' ||
    value === 'budget_limited' ||
    value === 'complete'
  ) {
    return value
  }
  return undefined
}

function normalizeGoalTokenBudget(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('goal token budget must be a finite number')
  }
  return Math.floor(value)
}

function normalizeGoalEventType(value: unknown): goalsDao.SessionGoalEventType {
  if (typeof value === 'string' && GOAL_EVENT_TYPES.has(value as goalsDao.SessionGoalEventType)) {
    return value as goalsDao.SessionGoalEventType
  }
  throw new Error('invalid goal event type')
}

function normalizeGoalEventMessage(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('goal event message must be a string')
  return value.trim() || null
}

function normalizeGoalEventMetadata(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('goal event metadata must be an object')
  }
  return value as Record<string, unknown>
}

export async function registerDbHandlers(options: RegisterDbHandlersOptions = {}): Promise<void> {
  await initializeDatabase()

  async function addMessagesBatch(
    msgs: messagesDao.MessageInput[]
  ): Promise<{ success: boolean; error?: string }> {
    if (!Array.isArray(msgs) || msgs.length === 0) return { success: true }
    const sessionIds = new Set(msgs.map((m) => m.sessionId))
    for (const sessionId of sessionIds) {
      const sessionMessages = msgs.filter((message) => message.sessionId === sessionId)
      const workspaceId = sessionMessages[0]?.workspaceId?.trim()
      if (!workspaceId || sessionMessages.some((message) => message.workspaceId !== workspaceId)) {
        return { success: false, error: 'session-workspace-required' }
      }
      const existing = await sessionsDao.getSession(sessionId, workspaceId)
      if (!existing) {
        const anyWorkspaceSession = await sessionsDao.getSession(sessionId)
        if (anyWorkspaceSession) return { success: false, error: 'session-workspace-mismatch' }
        const earliest = sessionMessages[0]
        await sessionsDao.createSession({
          id: sessionId,
          title: 'New Conversation',
          mode: 'chat',
          createdAt: earliest.createdAt,
          updatedAt: earliest.createdAt,
          workspaceId
        })
      }
    }
    await messagesDao.addMessages(msgs)
    for (const sessionId of sessionIds) {
      await emitSessionUpdated(sessionId, 'message-added')
    }
    return { success: true }
  }

  async function upsertMessage(msg: messagesDao.MessageInput): Promise<{
    success: boolean
    error?: string
  }> {
    // Upsert is used by streaming/final persistence. It is intentionally silent:
    // the renderer already has the live state, and emitting structural updates here
    // can trigger DB reloads that race against in-memory streaming.
    if (!msg.workspaceId?.trim()) return { success: false, error: 'session-workspace-required' }
    const existing = await sessionsDao.getSession(msg.sessionId, msg.workspaceId)
    if (!existing) {
      return { success: false, error: 'session-workspace-mismatch' }
    }
    recordDbUpsertTrace(msg)
    await messagesDao.upsertMessage(msg)
    return { success: true }
  }

  async function requireSessionWorkspace(sessionId: string, workspaceId: unknown): Promise<string> {
    const authorizedWorkspaceId = await requireDbWorkspace(workspaceId)
    if (!(await sessionsDao.getSession(sessionId, authorizedWorkspaceId))) {
      throw new Error('session-workspace-mismatch')
    }
    await requireDbWorkspace(authorizedWorkspaceId)
    return authorizedWorkspaceId
  }

  async function requireDbWorkspace(workspaceId: unknown): Promise<string> {
    return authorizeDbWorkspace(workspaceId, loadOfflineWorkspaceIds)
  }

  // --- Projects ---

  ipcMain.handle(DB_PROJECTS_LIST_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ workspaceId?: string } | null>(bytes)
    const workspaceId = await requireDbWorkspace(input?.workspaceId)
    const projects = await projectsDao.listProjects(workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(projects)
  })

  ipcMain.handle(DB_PROJECTS_GET_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ id: string; workspaceId?: string } | string>(bytes)
    const { id, workspaceId: rawWorkspaceId } =
      typeof input === 'string' ? { id: input, workspaceId: undefined } : input
    const workspaceId = await requireDbWorkspace(rawWorkspaceId)
    const project = await projectsDao.getProject(id, workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(project ?? null)
  })

  ipcMain.handle(DB_PROJECTS_ENSURE_DEFAULT_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ workspaceId?: string } | null>(bytes)
    const workspaceId = await requireDbWorkspace(input?.workspaceId)
    return encodeMessagePackPayload(await projectsDao.ensureDefaultProject(workspaceId))
  })

  ipcMain.handle(DB_PROJECTS_CREATE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const project = decodeMessagePackPayload<{
      id?: string
      name: string
      workingFolder?: string | null
      sshConnectionId?: string | null
      pluginId?: string | null
      pinned?: boolean
      createdAt?: number
      updatedAt?: number
      workspaceId?: string
      modelSource?: string | null
    }>(bytes)
    const workspaceId = await requireDbWorkspace(project.workspaceId)
    return encodeMessagePackPayload(await projectsDao.createProject({ ...project, workspaceId }))
  })

  ipcMain.handle(DB_PROJECTS_UPDATE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      id: string
      workspaceId: string
      patch: Partial<{
        name: string
        workingFolder: string | null
        sshConnectionId: string | null
        pluginId: string | null
        pinned: boolean
        updatedAt: number
        modelSource: string | null
      }>
    }>(bytes)
    const workspaceId = await requireDbWorkspace(args.workspaceId)
    await projectsDao.updateProject(args.id, workspaceId, args.patch)
    return encodeMessagePackPayload({ success: true })
  })

  ipcMain.handle(DB_PROJECTS_DELETE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ id: string; workspaceId?: string } | string>(bytes)
    const { id, workspaceId: rawWorkspaceId } =
      typeof input === 'string' ? { id: input, workspaceId: undefined } : input
    const workspaceId = await requireDbWorkspace(rawWorkspaceId)
    const result = await projectsDao.deleteProject(id, workspaceId)
    for (const sessionId of result?.sessionIds ?? []) {
      emitSessionDeleted(sessionId, 'project-deleted', options)
    }
    return encodeMessagePackPayload(result)
  })

  // --- Sessions ---

  ipcMain.handle(DB_SESSIONS_LIST_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{
      workspaceId?: string
      limit?: number
      offset?: number
    } | null>(bytes)
    const workspaceId = await requireDbWorkspace(input?.workspaceId)
    const sessions = await sessionsDao.listSessions(input?.limit, input?.offset, workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(sessions)
  })

  ipcMain.handle(DB_SESSIONS_GET_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ id: string; workspaceId?: string } | string>(bytes)
    const { id, workspaceId: rawWorkspaceId } =
      typeof input === 'string' ? { id: input, workspaceId: undefined } : input
    const workspaceId = await requireDbWorkspace(rawWorkspaceId)
    const session = await sessionsDao.getSession(id, workspaceId)
    if (!session) return encodeMessagePackPayload(null)
    const messages = await messagesDao.getMessages(id, session.workspace_id)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload({ session, messages })
  })

  ipcMain.handle(DB_SESSIONS_CREATE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const session = decodeMessagePackPayload<{
      id: string
      title: string
      mode: string
      createdAt: number
      updatedAt: number
      projectId?: string
      workingFolder?: string
      sshConnectionId?: string
      planId?: string | null
      pinned?: boolean
      pluginId?: string
      providerId?: string
      modelId?: string
      modelSelectionMode?: string
      modelSource?: string
      workspaceId?: string
    }>(bytes)
    const workspaceId = await requireDbWorkspace(session.workspaceId)
    await sessionsDao.createSession({ ...session, workspaceId })
    await emitSessionUpdated(session.id, 'session-created')
    return encodeMessagePackPayload({ success: true })
  })

  ipcMain.handle(DB_SESSIONS_UPDATE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      id: string
      workspaceId?: string
      patch: Partial<{
        title: string
        mode: string
        updatedAt: number
        projectId: string | null
        workingFolder: string | null
        sshConnectionId: string | null
        planId: string | null
        pinned: boolean
        pluginId: string | null
        providerId: string | null
        modelId: string | null
        modelSelectionMode: string | null
        modelSource: string | null
        workspaceId: string | null
      }>
    }>(bytes)
    const workspaceId = await requireDbWorkspace(args.workspaceId)
    await sessionsDao.updateSession(args.id, workspaceId, args.patch)
    await emitSessionUpdated(args.id, 'session-updated')
    return encodeMessagePackPayload({ success: true })
  })

  ipcMain.handle(DB_SESSIONS_DELETE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ id: string; workspaceId?: string } | string>(bytes)
    const { id, workspaceId: rawWorkspaceId } =
      typeof input === 'string' ? { id: input, workspaceId: undefined } : input
    const workspaceId = await requireDbWorkspace(rawWorkspaceId)
    await sessionsDao.deleteSession(id, workspaceId)
    emitSessionDeleted(id, 'session-deleted', options)
    return encodeMessagePackPayload({ success: true })
  })

  ipcMain.handle(DB_SESSIONS_CLEAR_ALL_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{ workspaceId?: string }>(bytes)
    const workspaceId = await requireDbWorkspace(args?.workspaceId)
    const result = await sessionsDao.clearAllSessions(workspaceId)
    const sessionIds = result.sessionIds
    for (const sessionId of sessionIds) {
      emitSessionDeleted(sessionId, 'session-cleared', options)
    }
    return encodeMessagePackPayload({ success: true })
  })

  // --- Messages ---

  ipcMain.handle(DB_MESSAGES_LIST_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<string | { sessionId: string; workspaceId?: string }>(
      bytes
    )
    const { sessionId, workspaceId } =
      typeof input === 'string' ? { sessionId: input, workspaceId: undefined } : input
    await requireSessionWorkspace(sessionId, workspaceId)
    const messages = await messagesDao.getMessages(sessionId, workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(messages)
  })

  ipcMain.handle(DB_MESSAGES_LIST_USER_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<string | { sessionId: string; workspaceId?: string }>(
      bytes
    )
    const { sessionId, workspaceId } =
      typeof input === 'string' ? { sessionId: input, workspaceId: undefined } : input
    await requireSessionWorkspace(sessionId, workspaceId)
    const messages = await messagesDao.getUserMessages(sessionId, workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(messages)
  })

  ipcMain.handle(DB_MESSAGES_LIST_MARKERS_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<string | { sessionId: string; workspaceId?: string }>(
      bytes
    )
    const { sessionId, workspaceId } =
      typeof input === 'string' ? { sessionId: input, workspaceId: undefined } : input
    await requireSessionWorkspace(sessionId, workspaceId)
    const markers = await messagesDao.getMessageMarkers(sessionId, workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(markers)
  })

  ipcMain.handle(DB_MESSAGES_LIST_LOCATOR_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<string | { sessionId: string; workspaceId?: string }>(
      bytes
    )
    const { sessionId, workspaceId } =
      typeof input === 'string' ? { sessionId: input, workspaceId: undefined } : input
    await requireSessionWorkspace(sessionId, workspaceId)
    const rows = await messagesDao.getMessageLocatorRows(sessionId, workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(rows)
  })

  ipcMain.handle(DB_MESSAGES_LIST_PAGE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      sessionId: string
      workspaceId?: string
      limit: number
      offset: number
    }>(bytes)
    await requireSessionWorkspace(args.sessionId, args.workspaceId)
    const rows = await messagesDao.getMessagesPage(
      args.sessionId,
      args.limit,
      args.offset,
      args.workspaceId
    )
    await requireDbWorkspace(args.workspaceId)
    return encodeMessagePackPayload(rows)
  })

  ipcMain.handle(DB_MESSAGES_REQUEST_CONTEXT_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      sessionId: string
      workspaceId?: string
      maxMessages: number
      headLimit?: number
    }>(bytes)
    await requireSessionWorkspace(args.sessionId, args.workspaceId)
    const rows = await messagesDao.getMessagesRequestContext(args)
    await requireDbWorkspace(args.workspaceId)
    return encodeMessagePackPayload(rows)
  })

  ipcMain.handle(DB_MESSAGES_WINDOW_AROUND_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      sessionId: string
      workspaceId?: string
      messageId?: string | null
      sortOrder?: number | null
      limit: number
    }>(bytes)
    await requireSessionWorkspace(args.sessionId, args.workspaceId)
    const window = await messagesDao.getMessagesWindowAround(args)
    await requireDbWorkspace(args.workspaceId)
    return encodeMessagePackPayload(window)
  })

  ipcMain.handle(DB_MESSAGES_SEARCH_CONTENT_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{ query: string; limit?: number; workspaceId?: string }>(
      bytes
    )
    const workspaceId = await authorizeMessageSearchWorkspace(
      args.workspaceId,
      loadOfflineWorkspaceIds
    )
    const matches = await messagesDao.searchMessageContent(
      args.query,
      args.limit ?? 50,
      workspaceId
    )
    const scoped = await Promise.all(
      matches.map(async (match) =>
        (await sessionsDao.getSession(match.session_id, workspaceId)) ? match : null
      )
    )
    await authorizeMessageSearchWorkspace(workspaceId, loadOfflineWorkspaceIds)
    return encodeMessagePackPayload(
      scoped.filter((match): match is messagesDao.MessageContentMatch => !!match)
    )
  })

  ipcMain.handle(DB_MESSAGES_ADD_BATCH_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    return await addMessagesBatch(decodeMessagePackPayload<messagesDao.MessageInput[]>(bytes))
  })

  ipcMain.handle(
    DB_MESSAGES_INSERT_ARTIFACTS_MSGPACK_CHANNEL,
    async (_event, bytes: Uint8Array) => {
      const args =
        decodeMessagePackPayload<Parameters<typeof messagesDao.insertMessageArtifacts>[0]>(bytes)
      await requireSessionWorkspace(args.sessionId, (args as { workspaceId?: unknown }).workspaceId)
      const result = await messagesDao.insertMessageArtifacts(args)
      await emitSessionUpdated(args.sessionId, 'messages-artifacts-inserted')
      return result
    }
  )

  ipcMain.handle(DB_MESSAGES_UPSERT_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    return await upsertMessage(decodeMessagePackPayload<messagesDao.MessageInput>(bytes))
  })

  ipcMain.handle(DB_MESSAGES_UPDATE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      id: string
      sessionId: string
      workspaceId: string
      patch: Partial<{ content: string; meta: string | null; usage: string | null }>
    }>(bytes)
    await requireSessionWorkspace(args.sessionId, args.workspaceId)
    await messagesDao.updateMessage(args.id, args.patch, args.workspaceId)
    return { success: true }
  })

  ipcMain.handle(DB_MESSAGES_CLEAR_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{ sessionId: string; workspaceId: string }>(bytes)
    await requireSessionWorkspace(args.sessionId, args.workspaceId)
    await messagesDao.clearMessages(args.sessionId, args.workspaceId)
    await emitSessionUpdated(args.sessionId, 'messages-cleared')
    return { success: true }
  })

  ipcMain.handle(DB_MESSAGES_DELETE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      sessionId: string
      messageId: string
      workspaceId: string
    }>(bytes)
    await requireSessionWorkspace(args.sessionId, args.workspaceId)
    const deleted = await messagesDao.deleteMessage(
      args.sessionId,
      args.messageId,
      args.workspaceId
    )
    if (deleted) await emitSessionUpdated(args.sessionId, 'message-deleted')
    return { success: true, deleted }
  })

  ipcMain.handle(DB_MESSAGES_REPLACE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      sessionId: string
      workspaceId: string
      messages: Array<{
        id: string
        role: string
        content: string
        meta?: string | null
        createdAt: number
        usage?: string | null
        sortOrder: number
      }>
    }>(bytes)
    await requireSessionWorkspace(args.sessionId, args.workspaceId)
    await messagesDao.replaceMessages(args.sessionId, args.messages, args.workspaceId)
    await emitSessionUpdated(args.sessionId, 'messages-replaced')
    return { success: true }
  })

  ipcMain.handle(DB_MESSAGES_TRUNCATE_FROM_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      sessionId: string
      workspaceId: string
      fromSortOrder: number
    }>(bytes)
    await requireSessionWorkspace(args.sessionId, args.workspaceId)
    await messagesDao.truncateMessagesFrom(args.sessionId, args.fromSortOrder, args.workspaceId)
    await emitSessionUpdated(args.sessionId, 'messages-truncated')
    return { success: true }
  })

  ipcMain.handle(DB_MESSAGES_COUNT_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<string | { sessionId: string; workspaceId?: string }>(
      bytes
    )
    const { sessionId, workspaceId } =
      typeof input === 'string' ? { sessionId: input, workspaceId: undefined } : input
    await requireSessionWorkspace(sessionId, workspaceId)
    const count = await messagesDao.getMessageCount(sessionId, workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(count)
  })

  // --- Goals ---

  ipcMain.handle(DB_GOALS_LIST_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ workspaceId?: string }>(bytes)
    const workspaceId = await requireDbWorkspace(input?.workspaceId)
    const goals = await goalsDao.listGoals(workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(goals)
  })

  ipcMain.handle(DB_GOALS_GET_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{ sessionId: string; workspaceId?: string }>(bytes)
    const workspaceId = await requireSessionWorkspace(args.sessionId, args.workspaceId)
    const goal = (await goalsDao.getGoal(args.sessionId, workspaceId)) ?? null
    await requireDbWorkspace(args.workspaceId)
    return encodeMessagePackPayload(goal)
  })

  ipcMain.handle(DB_GOALS_CREATE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      sessionId: string
      workspaceId?: string
      objective: unknown
      tokenBudget?: unknown
    }>(bytes)
    const workspaceId = await requireSessionWorkspace(args.sessionId, args.workspaceId)
    const previousGoal = (await goalsDao.getGoal(args.sessionId, workspaceId)) ?? null
    await requireDbWorkspace(args.workspaceId)
    const goal = await goalsDao.createGoal({
      sessionId: args.sessionId,
      workspaceId,
      objective: normalizeGoalObjective(args.objective),
      tokenBudget: normalizeGoalTokenBudget(args.tokenBudget) ?? null
    })
    await requireDbWorkspace(args.workspaceId)
    if (!goal) {
      return encodeMessagePackPayload({
        success: false,
        error: 'A goal already exists for this session'
      })
    }
    emitGoalUpdated(goal, 'goal-created')
    void getGoalRuntimeService().handleGoalMutation({
      sessionId: args.sessionId,
      previousGoal,
      nextGoal: goal,
      reason: 'goal-created'
    })
    return encodeMessagePackPayload({ success: true, goal })
  })

  ipcMain.handle(DB_GOALS_SET_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      sessionId: string
      workspaceId?: string
      objective: unknown
      status?: unknown
      tokenBudget?: unknown
    }>(bytes)
    const workspaceId = await requireSessionWorkspace(args.sessionId, args.workspaceId)
    const previousGoal = (await goalsDao.getGoal(args.sessionId, workspaceId)) ?? null
    await requireDbWorkspace(args.workspaceId)
    const goal = await goalsDao.replaceGoal({
      sessionId: args.sessionId,
      workspaceId,
      objective: normalizeGoalObjective(args.objective),
      status: normalizeGoalStatus(args.status) ?? 'active',
      tokenBudget: normalizeGoalTokenBudget(args.tokenBudget) ?? null
    })
    await requireDbWorkspace(args.workspaceId)
    emitGoalUpdated(goal, 'goal-set')
    void getGoalRuntimeService().handleGoalMutation({
      sessionId: args.sessionId,
      previousGoal,
      nextGoal: goal,
      reason: 'goal-set'
    })
    return encodeMessagePackPayload({ success: true, goal })
  })

  ipcMain.handle(DB_GOALS_UPDATE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      sessionId: string
      workspaceId?: string
      patch: {
        objective?: unknown
        status?: unknown
        tokenBudget?: unknown
      }
    }>(bytes)
    const workspaceId = await requireSessionWorkspace(args.sessionId, args.workspaceId)
    const patch: goalsDao.SessionGoalUpdate = {}
    if (args.patch.objective !== undefined) {
      patch.objective = normalizeGoalObjective(args.patch.objective)
    }
    if (args.patch.status !== undefined) {
      const status = normalizeGoalStatus(args.patch.status)
      if (!status) {
        return encodeMessagePackPayload({ success: false, error: 'Invalid goal status' })
      }
      patch.status = status
    }
    if (args.patch.tokenBudget !== undefined) {
      patch.tokenBudget = normalizeGoalTokenBudget(args.patch.tokenBudget) ?? null
    }

    const previousGoal = (await goalsDao.getGoal(args.sessionId, workspaceId)) ?? null
    await requireDbWorkspace(args.workspaceId)
    const goal = await goalsDao.updateGoal(args.sessionId, patch, workspaceId)
    await requireDbWorkspace(args.workspaceId)
    if (!goal) {
      return encodeMessagePackPayload({
        success: false,
        error: 'No goal exists for this session'
      })
    }
    emitGoalUpdated(goal, 'goal-updated')
    void getGoalRuntimeService().handleGoalMutation({
      sessionId: args.sessionId,
      previousGoal,
      nextGoal: goal,
      reason: 'goal-updated'
    })
    return encodeMessagePackPayload({ success: true, goal })
  })

  ipcMain.handle(DB_GOALS_CLEAR_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const { sessionId, workspaceId } = decodeMessagePackPayload<{
      sessionId: string
      workspaceId?: string
    }>(bytes)
    const authorizedWorkspaceId = await requireSessionWorkspace(sessionId, workspaceId)
    const previousGoal = (await goalsDao.getGoal(sessionId, authorizedWorkspaceId)) ?? null
    await requireDbWorkspace(workspaceId)
    const cleared = await goalsDao.clearGoal(sessionId, authorizedWorkspaceId)
    await requireDbWorkspace(workspaceId)
    if (cleared) {
      emitGoalCleared(sessionId, 'goal-cleared')
      void getGoalRuntimeService().handleGoalMutation({
        sessionId,
        previousGoal,
        nextGoal: null,
        reason: 'goal-cleared'
      })
    }
    return encodeMessagePackPayload({ success: true, cleared })
  })

  ipcMain.handle(DB_GOALS_ACCOUNT_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      sessionId: string
      workspaceId?: string
      timeDeltaSeconds: number
      tokenDelta: number
      expectedGoalId?: string | null
    }>(bytes)
    const workspaceId = await requireSessionWorkspace(args.sessionId, args.workspaceId)
    const goal = await goalsDao.accountGoalUsage({ ...args, workspaceId })
    await requireDbWorkspace(args.workspaceId)
    if (goal) {
      emitGoalUpdated(goal, 'goal-accounted')
    }
    return encodeMessagePackPayload({ success: true, goal })
  })

  ipcMain.handle(DB_GOAL_EVENTS_LIST_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      sessionId: string
      workspaceId?: string
      goalId?: string | null
      limit?: number
    }>(bytes)
    const workspaceId = await requireSessionWorkspace(args.sessionId, args.workspaceId)
    const events = await goalsDao.listGoalEvents({ ...args, workspaceId })
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(events)
  })

  ipcMain.handle(DB_GOAL_EVENTS_ADD_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      sessionId: string
      workspaceId?: string
      goalId?: string | null
      eventType: unknown
      message?: unknown
      metadata?: unknown
    }>(bytes)
    const workspaceId = await requireSessionWorkspace(args.sessionId, args.workspaceId)
    const event = await goalsDao.addGoalEvent({
      sessionId: args.sessionId,
      workspaceId,
      goalId: args.goalId,
      eventType: normalizeGoalEventType(args.eventType),
      message: normalizeGoalEventMessage(args.message),
      metadata: normalizeGoalEventMetadata(args.metadata)
    })
    await requireDbWorkspace(args.workspaceId)
    emitGoalEventAdded(event, 'goal-event-added')
    return encodeMessagePackPayload({ success: true, event })
  })

  // --- Usage Events ---

  ipcMain.handle(USAGE_EVENTS_ADD_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const payload =
      decodeMessagePackPayload<Parameters<typeof usageEventsDao.addUsageEvent>[0]>(bytes)
    await usageEventsDao.addUsageEvent(payload)
    return encodeMessagePackPayload({ success: true })
  })

  ipcMain.handle(USAGE_EVENTS_OVERVIEW_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const query = decodeMessagePackPayload<usageEventsDao.UsageEventsQuery>(bytes)
    return encodeMessagePackPayload(await usageEventsDao.getUsageOverview(query))
  })

  ipcMain.handle(USAGE_EVENTS_DAILY_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const query = decodeMessagePackPayload<usageEventsDao.UsageEventsQuery>(bytes)
    return encodeMessagePackPayload(await usageEventsDao.getUsageDaily(query))
  })

  ipcMain.handle(USAGE_EVENTS_TIMELINE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      query: usageEventsDao.UsageEventsQuery
      bucket: usageEventsDao.UsageTimelineBucket
    }>(bytes)
    return encodeMessagePackPayload(await usageEventsDao.getUsageTimeline(args.query, args.bucket))
  })

  ipcMain.handle(USAGE_EVENTS_BY_MODEL_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const query = decodeMessagePackPayload<usageEventsDao.UsageEventsQuery>(bytes)
    return encodeMessagePackPayload(await usageEventsDao.getUsageByModel(query))
  })

  ipcMain.handle(USAGE_EVENTS_BY_PROVIDER_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const query = decodeMessagePackPayload<usageEventsDao.UsageEventsQuery>(bytes)
    return encodeMessagePackPayload(await usageEventsDao.getUsageByProvider(query))
  })

  ipcMain.handle(USAGE_EVENTS_LIST_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const query = decodeMessagePackPayload<usageEventsDao.UsageEventsQuery>(bytes)
    return encodeMessagePackPayload(await usageEventsDao.listUsageEvents(query))
  })

  ipcMain.handle(USAGE_EVENTS_CLEAR_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const query = decodeMessagePackPayload<usageEventsDao.UsageEventsQuery>(bytes)
    return encodeMessagePackPayload(await usageEventsDao.deleteUsageEvents(query))
  })

  ipcMain.handle(USAGE_ACTIVITY_OVERVIEW_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const query = decodeMessagePackPayload<usageEventsDao.UsageActivityQuery>(bytes)
    return encodeMessagePackPayload(await usageEventsDao.getUsageActivityOverview(query))
  })

  ipcMain.handle(USAGE_ACTIVITY_DAILY_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const query = decodeMessagePackPayload<usageEventsDao.UsageActivityQuery>(bytes)
    return encodeMessagePackPayload(await usageEventsDao.getUsageActivityDaily(query))
  })

  ipcMain.handle(USAGE_ACTIVITY_BY_MODEL_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const query = decodeMessagePackPayload<usageEventsDao.UsageActivityQuery>(bytes)
    return encodeMessagePackPayload(await usageEventsDao.getUsageActivityByModel(query))
  })

  ipcMain.handle(USAGE_ACTIVITY_BY_PROVIDER_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const query = decodeMessagePackPayload<usageEventsDao.UsageActivityQuery>(bytes)
    return encodeMessagePackPayload(await usageEventsDao.getUsageActivityByProvider(query))
  })

  // --- Draw Runs ---

  ipcMain.handle(DB_DRAW_RUNS_LIST_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const workspaceId = decodeMessagePackPayload<string>(bytes)
    return encodeMessagePackPayload(await drawRunsDao.listDrawRuns(workspaceId))
  })

  ipcMain.handle(DB_DRAW_RUNS_SAVE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const run = decodeMessagePackPayload<{
      id: string
      workspaceId: string
      prompt: string
      providerName: string
      modelName: string
      mode?: string
      metaJson?: string | null
      createdAt: number
      isGenerating: boolean
      imagesJson: string
      errorJson?: string | null
      updatedAt: number
    }>(bytes)
    await drawRunsDao.saveDrawRun(run)
    return encodeMessagePackPayload({ success: true })
  })

  ipcMain.handle(DB_DRAW_RUNS_DELETE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const { id, workspaceId } = decodeMessagePackPayload<{ id: string; workspaceId: string }>(bytes)
    await drawRunsDao.deleteDrawRun(id, workspaceId)
    return encodeMessagePackPayload({ success: true })
  })

  ipcMain.handle(DB_DRAW_RUNS_CLEAR_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const workspaceId = decodeMessagePackPayload<string>(bytes)
    await drawRunsDao.clearDrawRuns(workspaceId)
    return encodeMessagePackPayload({ success: true })
  })

  // --- Plans ---

  ipcMain.handle(DB_PLANS_LIST_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ workspaceId?: string } | null>(bytes)
    const workspaceId = await requireDbWorkspace(input?.workspaceId)
    const plans = await plansDao.listPlans(workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(plans)
  })

  ipcMain.handle(DB_PLANS_GET_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ id: string; workspaceId?: string } | string>(bytes)
    const { id, workspaceId: rawWorkspaceId } =
      typeof input === 'string' ? { id: input, workspaceId: undefined } : input
    const workspaceId = await requireDbWorkspace(rawWorkspaceId)
    const plan = await plansDao.getPlan(id, workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(plan ?? null)
  })

  ipcMain.handle(DB_PLANS_GET_BY_SESSION_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ sessionId: string; workspaceId?: string } | string>(
      bytes
    )
    const { sessionId, workspaceId: rawWorkspaceId } =
      typeof input === 'string' ? { sessionId: input, workspaceId: undefined } : input
    const workspaceId = await requireDbWorkspace(rawWorkspaceId)
    const plan = await plansDao.getPlanBySession(sessionId, workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(plan ?? null)
  })

  ipcMain.handle(DB_PLANS_CREATE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const plan = decodeMessagePackPayload<{
      id: string
      sessionId: string
      title: string
      status?: string
      filePath?: string
      content?: string
      specJson?: string
      workspaceId?: string
      createdAt: number
      updatedAt: number
    }>(bytes)
    await requireSessionWorkspace(plan.sessionId, plan.workspaceId)
    await plansDao.createPlan(plan)
    return encodeMessagePackPayload({ success: true })
  })

  ipcMain.handle(DB_PLANS_UPDATE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      id: string
      workspaceId?: string
      patch: Partial<{
        title: string
        status: string
        filePath: string | null
        content: string | null
        specJson: string | null
        updatedAt: number
      }>
    }>(bytes)
    const workspaceId = await requireDbWorkspace(args.workspaceId)
    await plansDao.updatePlan(args.id, workspaceId, args.patch)
    return encodeMessagePackPayload({ success: true })
  })

  ipcMain.handle(DB_PLANS_DELETE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ id: string; workspaceId?: string } | string>(bytes)
    const { id, workspaceId: rawWorkspaceId } =
      typeof input === 'string' ? { id: input, workspaceId: undefined } : input
    const workspaceId = await requireDbWorkspace(rawWorkspaceId)
    await plansDao.deletePlan(id, workspaceId)
    return encodeMessagePackPayload({ success: true })
  })

  // --- Tasks (session-bound) ---

  ipcMain.handle(DB_TASKS_LIST_BY_SESSION_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ sessionId: string; workspaceId?: string } | string>(
      bytes
    )
    const { sessionId, workspaceId: rawWorkspaceId } =
      typeof input === 'string' ? { sessionId: input, workspaceId: undefined } : input
    const workspaceId = await requireDbWorkspace(rawWorkspaceId)
    const tasks = await tasksDao.listTasksBySession(sessionId, workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(tasks)
  })

  ipcMain.handle(DB_TASKS_LIST_ALL_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ workspaceId?: string } | null>(bytes)
    const workspaceId = await requireDbWorkspace(input?.workspaceId)
    const tasks = await tasksDao.listAllTasks(workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(tasks)
  })

  ipcMain.handle(DB_TASKS_GET_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ id: string; workspaceId?: string } | string>(bytes)
    const { id, workspaceId: rawWorkspaceId } =
      typeof input === 'string' ? { id: input, workspaceId: undefined } : input
    const workspaceId = await requireDbWorkspace(rawWorkspaceId)
    const task = await tasksDao.getTask(id, workspaceId)
    await requireDbWorkspace(workspaceId)
    return encodeMessagePackPayload(task ?? null)
  })

  ipcMain.handle(DB_TASKS_CREATE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const task = decodeMessagePackPayload<{
      id: string
      sessionId: string
      workspaceId: string
      planId?: string
      subject: string
      description: string
      activeForm?: string
      status?: string
      owner?: string
      blocks?: string[]
      blockedBy?: string[]
      metadata?: Record<string, unknown>
      sortOrder: number
      createdAt: number
      updatedAt: number
    }>(bytes)
    await requireSessionWorkspace(task.sessionId, task.workspaceId)
    await tasksDao.createTask(task)
    return encodeMessagePackPayload({ success: true })
  })

  ipcMain.handle(DB_TASKS_UPDATE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{
      id: string
      workspaceId: string
      patch: Partial<{
        subject: string
        description: string
        activeForm: string | null
        status: string
        owner: string | null
        blocks: string[]
        blockedBy: string[]
        metadata: Record<string, unknown> | null
        sortOrder: number
        updatedAt: number
      }>
    }>(bytes)
    const workspaceId = await requireDbWorkspace(args.workspaceId)
    await tasksDao.updateTask(args.id, workspaceId, args.patch)
    return encodeMessagePackPayload({ success: true })
  })

  ipcMain.handle(DB_TASKS_DELETE_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ id: string; workspaceId?: string } | string>(bytes)
    const { id, workspaceId: rawWorkspaceId } =
      typeof input === 'string' ? { id: input, workspaceId: undefined } : input
    const workspaceId = await requireDbWorkspace(rawWorkspaceId)
    await tasksDao.deleteTask(id, workspaceId)
    return encodeMessagePackPayload({ success: true })
  })

  ipcMain.handle(DB_TASKS_DELETE_BY_SESSION_MSGPACK_CHANNEL, async (_event, bytes: Uint8Array) => {
    const input = decodeMessagePackPayload<{ sessionId: string; workspaceId?: string } | string>(
      bytes
    )
    const { sessionId, workspaceId: rawWorkspaceId } =
      typeof input === 'string' ? { sessionId: input, workspaceId: undefined } : input
    const workspaceId = await requireDbWorkspace(rawWorkspaceId)
    await requireSessionWorkspace(sessionId, workspaceId)
    await tasksDao.deleteTasksBySession(sessionId, workspaceId)
    return encodeMessagePackPayload({ success: true })
  })
}
