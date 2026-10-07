import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  invoke: vi.fn(),
  clearSnapshot: vi.fn(),
  emit: vi.fn()
}))

vi.mock('../../src/renderer/src/lib/ipc/messagepack-ipc-client', () => ({
  invokeMessagePackBinary: fixture.invoke
}))
vi.mock('../../src/renderer/src/stores/chat-store', () => ({
  useChatStore: {
    getState: () => ({
      sessions: [{ id: 'session-a', workspaceId: 'workspace-a' }],
      clearSessionPromptSnapshot: fixture.clearSnapshot
    })
  }
}))
vi.mock('../../src/renderer/src/lib/agent-runtime-sync', () => ({
  emitAgentRuntimeSync: fixture.emit,
  isAgentRuntimeSyncSuppressed: () => false
}))

import {
  readTaskBoardMetadata,
  useTaskStore,
  withTaskBoardMetadata,
  type TaskItem
} from '../../src/renderer/src/stores/task-store'
import {
  DB_TASKS_DELETE_MSGPACK_CHANNEL,
  DB_TASKS_LIST_BY_SESSION_MSGPACK_CHANNEL,
  DB_TASKS_UPDATE_MSGPACK_CHANNEL
} from '../../src/shared/messagepack/binary-ipc'

const task: TaskItem = {
  id: 'task-a',
  sessionId: 'session-a',
  subject: 'Original',
  description: 'Original',
  status: 'pending',
  blocks: [],
  blockedBy: [],
  createdAt: 1,
  updatedAt: 1
}

describe('renderer task persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fixture.invoke.mockResolvedValue(true)
    useTaskStore.setState({
      tasks: [],
      todos: [],
      tasksBySession: {},
      currentSessionId: 'session-a'
    })
  })

  it('does not report or cache a task when create fails', async () => {
    fixture.invoke.mockRejectedValueOnce(new Error('disk full'))
    await expect(useTaskStore.getState().addTask(task)).rejects.toThrow('disk full')
    expect(useTaskStore.getState().getTask(task.id)).toBeUndefined()
    expect(fixture.emit).not.toHaveBeenCalled()
  })

  it('commits the task and emits its change only after storage confirms it', async () => {
    await useTaskStore.getState().addTask(task)
    expect(useTaskStore.getState().getTask(task.id)?.subject).toBe('Original')
    expect(fixture.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task_add' }))
  })

  it('keeps the previous task when update or delete fails', async () => {
    await useTaskStore.getState().addTask(task)
    fixture.emit.mockClear()
    fixture.invoke.mockRejectedValueOnce(new Error('write denied'))
    await expect(
      useTaskStore.getState().updateTask(task.id, { subject: 'Changed' })
    ).rejects.toThrow('write denied')
    expect(useTaskStore.getState().getTask(task.id)?.subject).toBe('Original')
    fixture.invoke.mockRejectedValueOnce(new Error('write denied'))
    await expect(useTaskStore.getState().deleteTask(task.id)).rejects.toThrow('write denied')
    expect(useTaskStore.getState().getTask(task.id)).toBeDefined()
    expect(fixture.emit).not.toHaveBeenCalled()
  })

  it('keeps session tasks until the batch delete is confirmed', async () => {
    await useTaskStore.getState().addTask(task)
    fixture.emit.mockClear()
    fixture.invoke.mockRejectedValueOnce(new Error('delete denied'))
    await expect(useTaskStore.getState().deleteSessionTasks('session-a')).rejects.toThrow(
      'delete denied'
    )
    expect(useTaskStore.getState().getTask(task.id)).toBeDefined()
    expect(fixture.emit).not.toHaveBeenCalled()

    await useTaskStore.getState().deleteSessionTasks('session-a')
    expect(useTaskStore.getState().getTask(task.id)).toBeUndefined()
    expect(fixture.emit).toHaveBeenCalledWith({
      kind: 'task_delete_session',
      sessionId: 'session-a'
    })
  })

  it('does not allow a new task to race with a session clear', async () => {
    await useTaskStore.getState().addTask(task)
    let finishDelete: (() => void) | undefined
    fixture.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve
        })
    )
    const clearing = useTaskStore.getState().deleteSessionTasks('session-a')
    expect(useTaskStore.getState().getTask(task.id)).toBeDefined()
    await expect(useTaskStore.getState().addTask({ ...task, id: 'task-b' })).rejects.toThrow(
      'TASK_SESSION_CLEAR_IN_PROGRESS'
    )
    finishDelete?.()
    await clearing
    expect(useTaskStore.getState().getTask(task.id)).toBeUndefined()
  })

  it('holds task writes while a conversation transaction clears the session', async () => {
    const release = useTaskStore.getState().beginSessionTaskClear('session-a')
    await expect(useTaskStore.getState().addTask(task)).rejects.toThrow(
      'TASK_SESSION_CLEAR_IN_PROGRESS'
    )
    await expect(useTaskStore.getState().deleteSessionTasks('session-a')).rejects.toThrow(
      'TASK_WRITE_IN_PROGRESS'
    )
    release()
    await expect(useTaskStore.getState().addTask(task)).resolves.toMatchObject({ id: task.id })
  })

  it('passes the cached version and reloads after a conflicting update', async () => {
    await useTaskStore.getState().addTask(task)
    const originalVersion = useTaskStore.getState().getTask(task.id)!.updatedAt
    const latestVersion = originalVersion + 5
    fixture.emit.mockClear()
    fixture.invoke.mockRejectedValueOnce(new Error('BUSINESS_TASK_CONFLICT'))
    fixture.invoke.mockResolvedValueOnce([
      {
        id: task.id,
        session_id: 'session-a',
        plan_id: null,
        subject: 'Other window',
        description: '',
        active_form: null,
        status: 'completed',
        owner: null,
        blocks: '[]',
        blocked_by: '[]',
        metadata: null,
        sort_order: 0,
        created_at: 1,
        updated_at: latestVersion
      }
    ])

    await expect(useTaskStore.getState().updateTask(task.id, { subject: 'Mine' })).rejects.toThrow(
      'BUSINESS_TASK_CONFLICT'
    )
    expect(fixture.invoke).toHaveBeenCalledWith(
      DB_TASKS_UPDATE_MSGPACK_CHANNEL,
      expect.objectContaining({ expectedUpdatedAt: originalVersion })
    )
    expect(fixture.invoke).toHaveBeenCalledWith(
      DB_TASKS_LIST_BY_SESSION_MSGPACK_CHANNEL,
      expect.objectContaining({ sessionId: 'session-a' })
    )
    expect(useTaskStore.getState().getTask(task.id)?.subject).toBe('Other window')
    expect(fixture.emit).not.toHaveBeenCalled()

    await useTaskStore.getState().deleteTask(task.id)
    expect(fixture.invoke).toHaveBeenCalledWith(
      DB_TASKS_DELETE_MSGPACK_CHANNEL,
      expect.objectContaining({ expectedUpdatedAt: latestVersion })
    )
  })

  it('ignores a list result started before a confirmed write', async () => {
    await useTaskStore.getState().addTask(task)
    let finishList: ((rows: unknown[]) => void) | undefined
    fixture.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishList = resolve
        })
    )
    const loading = useTaskStore.getState().refreshTasksForSession('session-a')
    await useTaskStore.getState().updateTask(task.id, { subject: 'Updated' })
    finishList?.([
      {
        id: task.id,
        session_id: 'session-a',
        plan_id: null,
        subject: 'Original',
        description: '',
        active_form: null,
        status: 'pending',
        owner: null,
        blocks: '[]',
        blocked_by: '[]',
        metadata: null,
        sort_order: 0,
        created_at: 1,
        updated_at: 1
      }
    ])
    await loading
    expect(useTaskStore.getState().getTask(task.id)?.subject).toBe('Updated')
  })

  it('stores edited calendar days as strings and reads local timeline projections', () => {
    const metadata = withTaskBoardMetadata(undefined, {
      startDate: '2026-10-01',
      dueDate: '2026-10-03'
    })
    expect(metadata.board).toEqual({ startDate: '2026-10-01', dueDate: '2026-10-03' })
    expect(readTaskBoardMetadata(metadata)).toMatchObject({
      startDate: '2026-10-01',
      dueDate: '2026-10-03',
      startAt: new Date(2026, 9, 1).getTime(),
      dueAt: new Date(2026, 9, 3).getTime()
    })
  })

  it('keeps legacy timestamps until that date is edited or cleared', () => {
    const startAt = new Date(2026, 9, 1).getTime()
    const dueAt = new Date(2026, 9, 3).getTime()
    const legacy = { board: { startAt, dueAt, priority: 'medium' }, source: 'existing' }
    expect(readTaskBoardMetadata(legacy)).toMatchObject({
      startDate: '2026-10-01',
      dueDate: '2026-10-03'
    })
    const priorityEdit = withTaskBoardMetadata(legacy, { priority: 'high' })
    expect(priorityEdit.board).toEqual({ startAt, dueAt, priority: 'high' })
    const dateEdit = withTaskBoardMetadata(priorityEdit, { dueDate: '2026-10-04' })
    expect(dateEdit.board).toEqual({ startAt, dueDate: '2026-10-04', priority: 'high' })
    const dateClear = withTaskBoardMetadata(dateEdit, { startDate: undefined })
    expect(dateClear.board).toEqual({ dueDate: '2026-10-04', priority: 'high' })
    expect(dateClear.source).toBe('existing')
  })
})
