import { create } from 'zustand'
import { emitAgentRuntimeSync, isAgentRuntimeSyncSuppressed } from '../lib/agent-runtime-sync'
import { invokeMessagePackBinary } from '../lib/ipc/messagepack-ipc-client'
import {
  DB_TASKS_CREATE_MSGPACK_CHANNEL,
  DB_TASKS_DELETE_BY_SESSION_MSGPACK_CHANNEL,
  DB_TASKS_DELETE_MSGPACK_CHANNEL,
  DB_TASKS_LIST_BY_SESSION_MSGPACK_CHANNEL,
  DB_TASKS_UPDATE_MSGPACK_CHANNEL
} from '../../../shared/messagepack/binary-ipc'
import { useChatStore } from './chat-store'
import { fromTaskDateInput, toTaskDateInput } from '../lib/task-calendar-date'

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'

export interface TaskBoardMetadata {
  priority?: TaskPriority
  tags?: string[]
  startDate?: string
  dueDate?: string
  /** Local-midnight projections for timeline calculations; never persisted for new edits. */
  startAt?: number
  dueAt?: number
}

export interface TaskItem {
  id: string
  sessionId?: string
  planId?: string
  subject: string
  description: string
  activeForm?: string
  status: TaskStatus
  owner?: string | null
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** @deprecated Use TaskItem instead */
export type TodoItem = TaskItem

// --- DB persistence helpers ---

function workspaceForSession(sessionId: string | undefined): string {
  if (!sessionId) return 'local-personal'
  return (
    useChatStore.getState().sessions.find((session) => session.id === sessionId)?.workspaceId ??
    'local-personal'
  )
}

function dbCreateTask(task: TaskItem, sortOrder: number): Promise<unknown> {
  if (!task.sessionId) return Promise.reject(new Error('TASK_SESSION_REQUIRED'))
  return invokeMessagePackBinary(DB_TASKS_CREATE_MSGPACK_CHANNEL, {
    id: task.id,
    sessionId: task.sessionId,
    workspaceId: workspaceForSession(task.sessionId),
    planId: task.planId,
    subject: task.subject,
    description: task.description,
    activeForm: task.activeForm,
    status: task.status,
    owner: task.owner,
    blocks: task.blocks,
    blockedBy: task.blockedBy,
    metadata: task.metadata,
    sortOrder,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  })
}

function dbUpdateTask(
  id: string,
  workspaceId: string,
  patch: Record<string, unknown>,
  expectedUpdatedAt: number
): Promise<unknown> {
  return invokeMessagePackBinary(DB_TASKS_UPDATE_MSGPACK_CHANNEL, {
    id,
    workspaceId,
    patch,
    expectedUpdatedAt
  })
}

function dbDeleteTask(
  id: string,
  workspaceId: string,
  expectedUpdatedAt: number
): Promise<unknown> {
  return invokeMessagePackBinary(DB_TASKS_DELETE_MSGPACK_CHANNEL, {
    id,
    workspaceId,
    expectedUpdatedAt
  })
}

function dbDeleteTasksBySession(sessionId: string, workspaceId: string): Promise<unknown> {
  return invokeMessagePackBinary(DB_TASKS_DELETE_BY_SESSION_MSGPACK_CHANNEL, {
    sessionId,
    workspaceId
  })
}

export interface TaskRow {
  id: string
  session_id: string
  plan_id: string | null
  subject: string
  description: string
  active_form: string | null
  status: string
  owner: string | null
  blocks: string
  blocked_by: string
  metadata: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

export function taskRowToItem(row: TaskRow): TaskItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    planId: row.plan_id ?? undefined,
    subject: row.subject,
    description: row.description,
    activeForm: row.active_form ?? undefined,
    status: normalizeTaskStatus(row.status),
    owner: row.owner,
    blocks: JSON.parse(row.blocks || '[]'),
    blockedBy: JSON.parse(row.blocked_by || '[]'),
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function normalizeTaskStatus(status: string): TaskStatus {
  return status === 'in_progress' ||
    status === 'in_review' ||
    status === 'blocked' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled'
    ? status
    : 'pending'
}

function isTaskStale(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('BUSINESS_TASK_CONFLICT') ||
      error.message.includes('BUSINESS_TASK_NOT_FOUND'))
  )
}

export function readTaskBoardMetadata(
  metadata: Record<string, unknown> | undefined
): TaskBoardMetadata {
  const board = metadata?.board
  if (!board || typeof board !== 'object' || Array.isArray(board)) return {}
  const value = board as Record<string, unknown>
  const priority = value.priority
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((tag): tag is string => typeof tag === 'string')
    : []
  const legacyStartAt =
    typeof value.startAt === 'number' && Number.isFinite(value.startAt) ? value.startAt : undefined
  const legacyDueAt =
    typeof value.dueAt === 'number' && Number.isFinite(value.dueAt) ? value.dueAt : undefined
  const startDate =
    typeof value.startDate === 'string' && fromTaskDateInput(value.startDate) !== undefined
      ? value.startDate
      : toTaskDateInput(legacyStartAt)
  const dueDate =
    typeof value.dueDate === 'string' && fromTaskDateInput(value.dueDate) !== undefined
      ? value.dueDate
      : toTaskDateInput(legacyDueAt)
  const startAt = startDate ? fromTaskDateInput(startDate) : undefined
  const dueAt = dueDate ? fromTaskDateInput(dueDate) : undefined
  return {
    ...(priority === 'low' || priority === 'medium' || priority === 'high' || priority === 'urgent'
      ? { priority }
      : {}),
    ...(tags.length ? { tags } : {}),
    ...(startDate ? { startDate, startAt } : {}),
    ...(dueDate ? { dueDate, dueAt } : {})
  }
}

export function withTaskBoardMetadata(
  metadata: Record<string, unknown> | undefined,
  patch: Partial<Pick<TaskBoardMetadata, 'priority' | 'tags' | 'startDate' | 'dueDate'>>
): Record<string, unknown> {
  const existing = metadata?.board
  const board: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  if (patch.priority !== undefined) board.priority = patch.priority
  if (patch.tags !== undefined) board.tags = patch.tags
  for (const [dateKey, legacyKey] of [
    ['startDate', 'startAt'],
    ['dueDate', 'dueAt']
  ] as const) {
    if (!Object.hasOwn(patch, dateKey)) continue
    delete board[legacyKey]
    const date = patch[dateKey]
    if (date && fromTaskDateInput(date) !== undefined) board[dateKey] = date
    else delete board[dateKey]
  }
  return { ...metadata, board }
}

function buildDbPatch(
  patch: Partial<Omit<TaskItem, 'id' | 'createdAt'>>,
  now: number
): Record<string, unknown> {
  const dbPatch: Record<string, unknown> = { updatedAt: now }
  if (patch.subject !== undefined) dbPatch.subject = patch.subject
  if (patch.description !== undefined) dbPatch.description = patch.description
  if (patch.activeForm !== undefined) dbPatch.activeForm = patch.activeForm
  if (patch.status !== undefined) dbPatch.status = patch.status
  if (patch.owner !== undefined) dbPatch.owner = patch.owner
  if (patch.blocks !== undefined) dbPatch.blocks = patch.blocks
  if (patch.blockedBy !== undefined) dbPatch.blockedBy = patch.blockedBy
  if (patch.metadata !== undefined) dbPatch.metadata = patch.metadata
  return dbPatch
}

interface TaskStore {
  tasks: TaskItem[]
  /** Session-scoped cache for background/concurrent session updates */
  tasksBySession: Record<string, TaskItem[]>
  /** The session ID tasks are currently loaded for */
  currentSessionId: string | null

  /** Load tasks for a session from DB */
  loadTasksForSession: (sessionId: string) => Promise<void>
  /** Refresh a session projection without changing the visible session. */
  refreshTasksForSession: (sessionId: string) => Promise<void>
  /** Add a single task (returns the added task) */
  addTask: (task: TaskItem) => Promise<TaskItem>
  /** Get a task by ID */
  getTask: (id: string) => TaskItem | undefined
  /** Update a task by ID (partial patch). Returns updated task or undefined if not found. */
  updateTask: (
    id: string,
    patch: Partial<Omit<TaskItem, 'id' | 'createdAt'>>
  ) => Promise<TaskItem | undefined>
  /** Delete a task by ID */
  deleteTask: (id: string) => Promise<boolean>
  /** Get all tasks */
  getTasks: () => TaskItem[]
  /** Get tasks for a specific session */
  getTasksBySession: (sessionId: string) => TaskItem[]
  /** Get the currently in_progress task */
  getActiveTask: () => TaskItem | undefined
  /** Get progress stats */
  getProgress: () => { total: number; completed: number; percentage: number }
  /** Clear all tasks in memory (does not touch DB) */
  clearTasks: () => void
  /** Hydrate cached session projections without creating a second task source. */
  cacheTasks: (tasks: TaskItem[]) => void
  releaseDormantSessionTasks: (residentSessionIds: string[]) => void
  /** Delete all tasks for a session from DB and memory */
  deleteSessionTasks: (sessionId: string) => Promise<void>
  /** Prevent local task writes while a conversation-level clear is being committed. */
  beginSessionTaskClear: (sessionId: string) => () => void
  /** Apply a task clear already committed with its parent conversation. */
  confirmSessionTasksCleared: (sessionId: string) => void
  applySyncedTaskAdd: (task: TaskItem) => void
  applySyncedTaskUpdate: (id: string, patch: Partial<Omit<TaskItem, 'id' | 'createdAt'>>) => void
  applySyncedTaskDelete: (id: string) => void
  applySyncedDeleteSessionTasks: (sessionId: string) => void

  // --- Backward-compatible aliases ---
  /** @deprecated Use tasks */
  todos: TaskItem[]
  /** @deprecated Use addTask / getTasks */
  setTodos: (todos: TaskItem[]) => void
  /** @deprecated Use getTasks */
  getTodos: () => TaskItem[]
  /** @deprecated Use getActiveTask */
  getActiveTodo: () => TaskItem | undefined
}

const pendingTaskWrites = new Set<string>()
const pendingSessionWrites = new Map<string, number>()
const pendingSessionClears = new Set<string>()
const sessionLoadRevision = new Map<string, number>()

function invalidateSessionTaskLoads(sessionId: string): number {
  const revision = (sessionLoadRevision.get(sessionId) ?? 0) + 1
  sessionLoadRevision.set(sessionId, revision)
  return revision
}

function beginTaskWrite(sessionId: string): void {
  if (pendingSessionClears.has(sessionId)) throw new Error('TASK_SESSION_CLEAR_IN_PROGRESS')
  pendingSessionWrites.set(sessionId, (pendingSessionWrites.get(sessionId) ?? 0) + 1)
}

function endTaskWrite(sessionId: string): void {
  const pending = (pendingSessionWrites.get(sessionId) ?? 1) - 1
  if (pending > 0) pendingSessionWrites.set(sessionId, pending)
  else pendingSessionWrites.delete(sessionId)
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  tasksBySession: {},
  currentSessionId: null,

  loadTasksForSession: async (sessionId) => {
    // Show cached tasks immediately to avoid stale UI while DB is loading.
    set((state) => {
      const cached = state.tasksBySession[sessionId] ?? []
      return { currentSessionId: sessionId, tasks: cached, todos: cached }
    })

    try {
      await get().refreshTasksForSession(sessionId)
    } catch (err) {
      console.error('[TaskStore] Failed to load tasks for session:', err)
    }
  },

  refreshTasksForSession: async (sessionId) => {
    const revision = invalidateSessionTaskLoads(sessionId)
    const rows = await invokeMessagePackBinary<TaskRow[]>(
      DB_TASKS_LIST_BY_SESSION_MSGPACK_CHANNEL,
      {
        sessionId,
        workspaceId: workspaceForSession(sessionId)
      }
    )
    if (sessionLoadRevision.get(sessionId) !== revision) return
    const tasks = rows.map(taskRowToItem)
    set((state) => {
      const nextTasksBySession = { ...state.tasksBySession, [sessionId]: tasks }
      if (state.currentSessionId !== sessionId) return { tasksBySession: nextTasksBySession }
      return { tasks, todos: tasks, tasksBySession: nextTasksBySession }
    })
  },

  addTask: async (task) => {
    const now = Date.now()
    const newTask: TaskItem = {
      ...task,
      blocks: task.blocks ?? [],
      blockedBy: task.blockedBy ?? [],
      createdAt: task.createdAt ?? now,
      updatedAt: now
    }
    if (!newTask.sessionId) throw new Error('TASK_SESSION_REQUIRED')
    beginTaskWrite(newTask.sessionId)
    try {
      const sortOrder = get().getTasksBySession(newTask.sessionId).length
      await dbCreateTask(newTask, sortOrder)
      invalidateSessionTaskLoads(newTask.sessionId)
      get().applySyncedTaskAdd(newTask)
      useChatStore.getState().clearSessionPromptSnapshot(newTask.sessionId)
      if (!isAgentRuntimeSyncSuppressed()) {
        emitAgentRuntimeSync({ kind: 'task_add', task: newTask })
      }
      return newTask
    } finally {
      endTaskWrite(newTask.sessionId)
    }
  },

  getTask: (id) => {
    const state = get()
    const current = state.tasks.find((t) => t.id === id)
    if (current) return current

    for (const sessionTasks of Object.values(state.tasksBySession)) {
      const found = sessionTasks.find((t) => t.id === id)
      if (found) return found
    }

    return undefined
  },

  updateTask: async (id, patch) => {
    const current = get().getTask(id)
    if (!current) return undefined
    if (!current.sessionId) throw new Error('TASK_SESSION_REQUIRED')
    if (pendingTaskWrites.has(id)) throw new Error('TASK_WRITE_IN_PROGRESS')
    beginTaskWrite(current.sessionId)
    pendingTaskWrites.add(id)
    try {
      const updatedAt = Math.max(Date.now(), current.updatedAt + 1)
      const updatedTask = { ...current, ...patch, updatedAt }
      await dbUpdateTask(
        id,
        workspaceForSession(current.sessionId),
        buildDbPatch(patch, updatedAt),
        current.updatedAt
      )
      invalidateSessionTaskLoads(current.sessionId)
      get().applySyncedTaskUpdate(id, { ...patch, updatedAt })
      useChatStore.getState().clearSessionPromptSnapshot(current.sessionId)
      if (!isAgentRuntimeSyncSuppressed()) {
        emitAgentRuntimeSync({ kind: 'task_update', id, patch: { ...patch, updatedAt } })
      }
      return updatedTask
    } catch (error) {
      if (isTaskStale(error)) {
        await get()
          .refreshTasksForSession(current.sessionId)
          .catch((refreshError) =>
            console.error('[TaskStore] Failed to refresh conflicted task:', refreshError)
          )
      }
      throw error
    } finally {
      pendingTaskWrites.delete(id)
      endTaskWrite(current.sessionId)
    }
  },

  deleteTask: async (id) => {
    const current = get().getTask(id)
    if (!current) return false
    if (!current.sessionId) throw new Error('TASK_SESSION_REQUIRED')
    if (pendingTaskWrites.has(id)) throw new Error('TASK_WRITE_IN_PROGRESS')
    beginTaskWrite(current.sessionId)
    pendingTaskWrites.add(id)
    try {
      await dbDeleteTask(id, workspaceForSession(current.sessionId), current.updatedAt)
      invalidateSessionTaskLoads(current.sessionId)
      get().applySyncedTaskDelete(id)
      useChatStore.getState().clearSessionPromptSnapshot(current.sessionId)
      if (!isAgentRuntimeSyncSuppressed()) {
        emitAgentRuntimeSync({ kind: 'task_delete', id })
      }
      return true
    } catch (error) {
      if (isTaskStale(error)) {
        await get()
          .refreshTasksForSession(current.sessionId)
          .catch((refreshError) =>
            console.error('[TaskStore] Failed to refresh conflicted task:', refreshError)
          )
      }
      throw error
    } finally {
      pendingTaskWrites.delete(id)
      endTaskWrite(current.sessionId)
    }
  },

  getTasks: () => get().tasks,

  getTasksBySession: (sessionId) => {
    const state = get()
    if (state.currentSessionId === sessionId) return state.tasks
    return state.tasksBySession[sessionId] ?? []
  },

  getActiveTask: () => get().tasks.find((t) => t.status === 'in_progress'),

  getProgress: () => {
    const { tasks } = get()
    const total = tasks.length
    const completed = tasks.filter((t) => t.status === 'completed').length
    return {
      total,
      completed,
      percentage: total === 0 ? 0 : Math.round((completed / total) * 100)
    }
  },

  clearTasks: () => set({ tasks: [], todos: [], currentSessionId: null }),

  cacheTasks: (tasks) => {
    set((state) => {
      const tasksBySession = { ...state.tasksBySession }
      for (const task of tasks) {
        if (!task.sessionId) continue
        const current = tasksBySession[task.sessionId] ?? []
        const index = current.findIndex((item) => item.id === task.id)
        tasksBySession[task.sessionId] =
          index === -1 ? [...current, task] : current.map((item, i) => (i === index ? task : item))
      }
      return { tasksBySession }
    })
  },

  releaseDormantSessionTasks: (residentSessionIds) => {
    const residentSet = new Set(residentSessionIds)
    set((state) => {
      for (const sessionId of Object.keys(state.tasksBySession)) {
        if (!residentSet.has(sessionId)) {
          delete state.tasksBySession[sessionId]
        }
      }

      if (state.currentSessionId && !residentSet.has(state.currentSessionId)) {
        return { tasks: [], todos: [], currentSessionId: null }
      }
      return {}
    })
  },

  deleteSessionTasks: async (sessionId) => {
    const release = get().beginSessionTaskClear(sessionId)
    const workspaceId = workspaceForSession(sessionId)
    try {
      await dbDeleteTasksBySession(sessionId, workspaceId)
      get().confirmSessionTasksCleared(sessionId)
    } finally {
      release()
    }
  },

  beginSessionTaskClear: (sessionId) => {
    if (pendingSessionClears.has(sessionId) || pendingSessionWrites.has(sessionId))
      throw new Error('TASK_WRITE_IN_PROGRESS')
    pendingSessionClears.add(sessionId)
    return () => pendingSessionClears.delete(sessionId)
  },

  confirmSessionTasksCleared: (sessionId) => {
    invalidateSessionTaskLoads(sessionId)
    get().applySyncedDeleteSessionTasks(sessionId)
    useChatStore.getState().clearSessionPromptSnapshot(sessionId)
    if (!isAgentRuntimeSyncSuppressed()) {
      emitAgentRuntimeSync({ kind: 'task_delete_session', sessionId })
    }
  },

  applySyncedTaskAdd: (task) => {
    const syncedTask: TaskItem = {
      ...task,
      blocks: task.blocks ?? [],
      blockedBy: task.blockedBy ?? []
    }

    set((state) => {
      const sessionId = syncedTask.sessionId
      if (!sessionId) {
        if (state.tasks.some((item) => item.id === syncedTask.id)) {
          const tasks = state.tasks.map((item) => (item.id === syncedTask.id ? syncedTask : item))
          return { tasks, todos: tasks }
        }
        const tasks = [...state.tasks, syncedTask]
        return { tasks, todos: tasks }
      }

      const sessionTasks =
        state.tasksBySession[sessionId] ?? (state.currentSessionId === sessionId ? state.tasks : [])
      const existingIndex = sessionTasks.findIndex((item) => item.id === syncedTask.id)
      const nextSessionTasks = [...sessionTasks]
      if (existingIndex !== -1) {
        nextSessionTasks[existingIndex] = syncedTask
      } else {
        nextSessionTasks.push(syncedTask)
      }

      const nextTasksBySession = { ...state.tasksBySession, [sessionId]: nextSessionTasks }
      if (state.currentSessionId === sessionId) {
        return {
          tasks: nextSessionTasks,
          todos: nextSessionTasks,
          tasksBySession: nextTasksBySession
        }
      }
      return { tasksBySession: nextTasksBySession }
    })
  },

  applySyncedTaskUpdate: (id, patch) => {
    set((state) => {
      const nextTasksBySession = { ...state.tasksBySession }

      const sessionEntries = Object.entries(state.tasksBySession)
      if (state.currentSessionId && !state.tasksBySession[state.currentSessionId]) {
        sessionEntries.push([state.currentSessionId, state.tasks])
      }

      for (const [sessionId, sessionTasks] of sessionEntries) {
        const idx = sessionTasks.findIndex((task) => task.id === id)
        if (idx === -1) continue

        const nextSessionTasks = [...sessionTasks]
        nextSessionTasks[idx] = { ...nextSessionTasks[idx], ...patch }
        nextTasksBySession[sessionId] = nextSessionTasks

        if (state.currentSessionId === sessionId) {
          return {
            tasks: nextSessionTasks,
            todos: nextSessionTasks,
            tasksBySession: nextTasksBySession
          }
        }
        return { tasksBySession: nextTasksBySession }
      }

      const taskIndex = state.tasks.findIndex((task) => task.id === id)
      if (taskIndex !== -1) {
        const tasks = [...state.tasks]
        tasks[taskIndex] = { ...tasks[taskIndex], ...patch }
        return { tasks, todos: tasks }
      }

      return {}
    })
  },

  applySyncedTaskDelete: (id) => {
    set((state) => {
      const nextTasksBySession = { ...state.tasksBySession }
      const sessionEntries = Object.entries(state.tasksBySession)
      if (state.currentSessionId && !state.tasksBySession[state.currentSessionId]) {
        sessionEntries.push([state.currentSessionId, state.tasks])
      }

      for (const [sessionId, sessionTasks] of sessionEntries) {
        const hasTarget = sessionTasks.some((task) => task.id === id)
        if (!hasTarget) continue

        const cleaned = sessionTasks
          .filter((task) => task.id !== id)
          .map((task) => ({
            ...task,
            blocks: task.blocks.filter((item) => item !== id),
            blockedBy: task.blockedBy.filter((item) => item !== id)
          }))
        nextTasksBySession[sessionId] = cleaned

        if (state.currentSessionId === sessionId) {
          return { tasks: cleaned, todos: cleaned, tasksBySession: nextTasksBySession }
        }
        return { tasksBySession: nextTasksBySession }
      }

      const hasCurrent = state.tasks.some((task) => task.id === id)
      if (!hasCurrent) return {}
      const tasks = state.tasks.filter((task) => task.id !== id)
      return { tasks, todos: tasks }
    })
  },

  applySyncedDeleteSessionTasks: (sessionId) => {
    set((state) => {
      const nextTasksBySession = { ...state.tasksBySession }
      delete nextTasksBySession[sessionId]

      if (state.currentSessionId !== sessionId) {
        return { tasksBySession: nextTasksBySession }
      }

      return {
        tasks: [],
        todos: [],
        currentSessionId: null,
        tasksBySession: nextTasksBySession
      }
    })
  },

  // --- Backward-compatible aliases ---
  todos: [],

  setTodos: (todos) => {
    const now = Date.now()
    const tasks = todos.map((t) => ({
      ...t,
      blocks: t.blocks ?? [],
      blockedBy: t.blockedBy ?? [],
      createdAt: t.createdAt ?? now,
      updatedAt: now
    }))
    set((state) => {
      if (!state.currentSessionId) return { tasks, todos: tasks }
      return {
        tasks,
        todos: tasks,
        tasksBySession: {
          ...state.tasksBySession,
          [state.currentSessionId]: tasks
        }
      }
    })
  },

  getTodos: () => get().tasks,

  getActiveTodo: () => get().tasks.find((t) => t.status === 'in_progress')
}))
