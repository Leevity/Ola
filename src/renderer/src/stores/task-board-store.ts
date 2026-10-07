import { create } from 'zustand'
import { useWorkspaceStore } from './workspace-store'
import { ensureWindowWorkspaceRegistered } from '@renderer/lib/window-workspace-registration'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { DB_TASKS_LIST_ALL_MSGPACK_CHANNEL } from '../../../shared/messagepack/binary-ipc'
import {
  taskRowToItem,
  useTaskStore,
  type TaskBoardMetadata,
  type TaskItem,
  type TaskRow
} from './task-store'

export type TaskBoardView = 'dashboard' | 'kanban' | 'list' | 'gantt'

interface TaskBoardStore {
  tasks: TaskItem[]
  loading: boolean
  error: string | null
  loadedAt: number | null
  selectedTaskId: string | null
  view: TaskBoardView
  load: () => Promise<void>
  requestRefresh: () => void
  setView: (view: TaskBoardView) => void
  selectTask: (taskId: string | null) => void
  updateMetadata: (taskId: string, metadata: TaskBoardMetadata) => Promise<void>
}

let latestLoad = 0
let loadedWorkspaceId: string | null = null
let projectionTimer: ReturnType<typeof setTimeout> | null = null
let applyingProjection = false

/** A cross-session projection; task-store remains the only mutation and persistence source. */
export const useTaskBoardStore = create<TaskBoardStore>((set) => ({
  tasks: [],
  loading: false,
  error: null,
  loadedAt: null,
  selectedTaskId: null,
  view: 'dashboard',

  load: async () => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
    const requestId = ++latestLoad
    const workspaceChanged = loadedWorkspaceId !== null && loadedWorkspaceId !== workspaceId
    if (workspaceChanged) loadedWorkspaceId = workspaceId
    set({
      loading: true,
      error: null,
      ...(workspaceChanged ? { tasks: [], selectedTaskId: null, loadedAt: null } : {})
    })
    try {
      await ensureWindowWorkspaceRegistered(workspaceId)
      if (
        requestId !== latestLoad ||
        workspaceId !== useWorkspaceStore.getState().activeWorkspaceId
      )
        return
      const rows = await invokeMessagePackBinary<TaskRow[]>(DB_TASKS_LIST_ALL_MSGPACK_CHANNEL, {
        workspaceId
      })
      if (
        requestId !== latestLoad ||
        workspaceId !== useWorkspaceStore.getState().activeWorkspaceId
      )
        return
      const tasks = rows.map(taskRowToItem)
      applyingProjection = true
      try {
        useTaskStore.getState().cacheTasks(tasks)
      } finally {
        applyingProjection = false
      }
      loadedWorkspaceId = workspaceId
      set((state) => ({
        tasks,
        loadedAt: Date.now(),
        selectedTaskId:
          state.selectedTaskId && tasks.some((task) => task.id === state.selectedTaskId)
            ? state.selectedTaskId
            : null
      }))
    } catch (error) {
      if (
        requestId === latestLoad &&
        workspaceId === useWorkspaceStore.getState().activeWorkspaceId
      ) {
        console.error('[TaskBoardStore] Failed to load task projection:', error)
        set({ error: String(error) })
      }
    } finally {
      if (
        requestId === latestLoad &&
        workspaceId === useWorkspaceStore.getState().activeWorkspaceId
      )
        set({ loading: false })
    }
  },

  requestRefresh: () => {
    const board = useTaskBoardStore.getState()
    if (board.loadedAt === null && !board.loading) return
    if (projectionTimer) clearTimeout(projectionTimer)
    projectionTimer = setTimeout(() => {
      projectionTimer = null
      void useTaskBoardStore.getState().load()
    }, 50)
  },

  setView: (view) => set({ view }),
  selectTask: (selectedTaskId) => set({ selectedTaskId }),

  updateMetadata: async (taskId, metadata) => {
    const task = useTaskBoardStore.getState().tasks.find((item) => item.id === taskId)
    if (!task) return
    const existing = task.metadata ?? {}
    const nextMetadata = { ...existing, board: { ...(existing.board as object), ...metadata } }
    const updated = await useTaskStore.getState().updateTask(taskId, { metadata: nextMetadata })
    if (!updated) return
    set((state) => ({ tasks: state.tasks.map((item) => (item.id === taskId ? updated : item)) }))
  }
}))

useWorkspaceStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId !== previous.activeWorkspaceId) {
    if (projectionTimer) clearTimeout(projectionTimer)
    projectionTimer = null
    void useTaskBoardStore.getState().load()
  }
})

useTaskStore.subscribe((state, previous) => {
  const board = useTaskBoardStore.getState()
  if (applyingProjection || (board.loadedAt === null && !board.loading)) return
  if (state.tasks === previous.tasks && state.tasksBySession === previous.tasksBySession) return
  board.requestRefresh()
})
