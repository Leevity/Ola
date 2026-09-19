import { create } from 'zustand'
import { useWorkspaceStore } from './workspace-store'
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
  loadedAt: number | null
  selectedTaskId: string | null
  view: TaskBoardView
  load: () => Promise<void>
  setView: (view: TaskBoardView) => void
  selectTask: (taskId: string | null) => void
  updateMetadata: (taskId: string, metadata: TaskBoardMetadata) => void
}

/** A cross-session projection; task-store remains the only mutation and persistence source. */
export const useTaskBoardStore = create<TaskBoardStore>((set) => ({
  tasks: [],
  loading: false,
  loadedAt: null,
  selectedTaskId: null,
  view: 'dashboard',

  load: async () => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
    set({ loading: true, tasks: [], selectedTaskId: null })
    try {
      const rows = await invokeMessagePackBinary<TaskRow[]>(DB_TASKS_LIST_ALL_MSGPACK_CHANNEL, {
        workspaceId
      })
      if (workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) return
      const tasks = rows.map(taskRowToItem)
      useTaskStore.getState().cacheTasks(tasks)
      set({ tasks, loadedAt: Date.now() })
    } catch (error) {
      console.error('[TaskBoardStore] Failed to load task projection:', error)
    } finally {
      set({ loading: false })
    }
  },

  setView: (view) => set({ view }),
  selectTask: (selectedTaskId) => set({ selectedTaskId }),

  updateMetadata: (taskId, metadata) => {
    const task = useTaskBoardStore.getState().tasks.find((item) => item.id === taskId)
    if (!task) return
    const existing = task.metadata ?? {}
    const nextMetadata = { ...existing, board: { ...(existing.board as object), ...metadata } }
    const updated = useTaskStore.getState().updateTask(taskId, { metadata: nextMetadata })
    if (!updated) return
    set((state) => ({ tasks: state.tasks.map((item) => (item.id === taskId ? updated : item)) }))
  }
}))

useWorkspaceStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId !== previous.activeWorkspaceId) {
    void useTaskBoardStore.getState().load()
  }
})
