import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  invoke: vi.fn(),
  registerWorkspace: vi.fn(async () => {}),
  workspaceId: 'workspace-a'
}))

vi.mock('../../src/renderer/src/lib/ipc/messagepack-ipc-client', () => ({
  invokeMessagePackBinary: fixture.invoke
}))
vi.mock('../../src/renderer/src/lib/window-workspace-registration', () => ({
  ensureWindowWorkspaceRegistered: fixture.registerWorkspace
}))
vi.mock('../../src/renderer/src/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: () => ({ activeWorkspaceId: fixture.workspaceId }),
    subscribe: vi.fn()
  }
}))
vi.mock('../../src/renderer/src/stores/chat-store', () => ({
  useChatStore: {
    getState: () => ({
      sessions: [{ id: 'session-a', workspaceId: 'workspace-a' }],
      clearSessionPromptSnapshot: vi.fn()
    })
  }
}))
vi.mock('../../src/renderer/src/lib/agent-runtime-sync', () => ({
  emitAgentRuntimeSync: vi.fn(),
  isAgentRuntimeSyncSuppressed: () => false
}))

import { DB_TASKS_LIST_ALL_MSGPACK_CHANNEL } from '../../src/shared/messagepack/binary-ipc'
import { useTaskBoardStore } from '../../src/renderer/src/stores/task-board-store'
import { useTaskStore } from '../../src/renderer/src/stores/task-store'

afterEach(() => {
  vi.useRealTimers()
  fixture.workspaceId = 'workspace-a'
})

it('refreshes the cross-session board after a confirmed task mutation without blanking it', async () => {
  fixture.workspaceId = 'workspace-a'
  vi.useFakeTimers()
  fixture.rows = [
    {
      id: 'task-a',
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
  ]
  fixture.invoke.mockImplementation(async (channel: string) =>
    channel === DB_TASKS_LIST_ALL_MSGPACK_CHANNEL ? fixture.rows : true
  )
  useTaskBoardStore.setState({ tasks: [], loadedAt: null, selectedTaskId: null })
  useTaskStore.setState({ tasks: [], todos: [], tasksBySession: {}, currentSessionId: null })

  await useTaskBoardStore.getState().load()
  expect(fixture.registerWorkspace).toHaveBeenCalledWith('workspace-a')
  useTaskBoardStore.getState().selectTask('task-a')
  fixture.rows = [{ ...fixture.rows[0], subject: 'Updated' }]
  await useTaskStore.getState().updateTask('task-a', { subject: 'Updated' })

  expect(useTaskBoardStore.getState().tasks[0]?.subject).toBe('Original')
  expect(useTaskBoardStore.getState().selectedTaskId).toBe('task-a')
  await vi.advanceTimersByTimeAsync(60)
  expect(useTaskBoardStore.getState().tasks[0]?.subject).toBe('Updated')
  expect(useTaskBoardStore.getState().selectedTaskId).toBe('task-a')

  fixture.rows = [{ ...fixture.rows[0], subject: 'Other window' }]
  fixture.invoke.mockClear()
  useTaskBoardStore.getState().requestRefresh()
  useTaskBoardStore.getState().requestRefresh()
  await vi.advanceTimersByTimeAsync(60)
  expect(useTaskBoardStore.getState().tasks[0]?.subject).toBe('Other window')
  expect(fixture.invoke).toHaveBeenCalledTimes(1)
})

it('ignores a slow response from the previous workspace after switching', async () => {
  fixture.workspaceId = 'workspace-a'
  fixture.invoke.mockReset()
  let finishOldLoad: ((rows: unknown[]) => void) | undefined
  const oldRows = new Promise<unknown[]>((resolve) => {
    finishOldLoad = resolve
  })
  fixture.invoke.mockImplementation((_channel: string, input: { workspaceId: string }) =>
    input.workspaceId === 'workspace-a'
      ? oldRows
      : [
          {
            id: 'task-b',
            session_id: 'session-b',
            plan_id: null,
            subject: 'Workspace B only',
            description: '',
            active_form: null,
            status: 'pending',
            owner: null,
            blocks: '[]',
            blocked_by: '[]',
            metadata: null,
            sort_order: 0,
            created_at: 2,
            updated_at: 2
          }
        ]
  )
  useTaskBoardStore.setState({ tasks: [], loadedAt: null, selectedTaskId: null, error: null })
  const oldLoad = useTaskBoardStore.getState().load()
  await vi.waitFor(() => expect(fixture.invoke).toHaveBeenCalledTimes(1))

  fixture.workspaceId = 'workspace-b'
  await useTaskBoardStore.getState().load()
  expect(useTaskBoardStore.getState().tasks.map((task) => task.subject)).toEqual([
    'Workspace B only'
  ])
  finishOldLoad?.([
    {
      id: 'task-a',
      session_id: 'session-a',
      subject: 'Stale workspace A task'
    }
  ])
  await oldLoad
  expect(useTaskBoardStore.getState().tasks.map((task) => task.subject)).toEqual([
    'Workspace B only'
  ])
  expect(useTaskBoardStore.getState().error).toBeNull()
})

it('keeps a load failure visible until a successful retry', async () => {
  fixture.workspaceId = 'workspace-a'
  fixture.invoke.mockReset()
  fixture.invoke.mockRejectedValueOnce(new Error('temporary board read failure'))
  fixture.invoke.mockResolvedValueOnce([])
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    useTaskBoardStore.setState({ tasks: [], loadedAt: null, error: null, loading: false })
    await useTaskBoardStore.getState().load()
    expect(useTaskBoardStore.getState().error).toContain('temporary board read failure')
    expect(useTaskBoardStore.getState().loading).toBe(false)

    await useTaskBoardStore.getState().load()
    expect(useTaskBoardStore.getState().error).toBeNull()
    expect(useTaskBoardStore.getState().tasks).toEqual([])
    expect(useTaskBoardStore.getState().loading).toBe(false)
    expect(useTaskBoardStore.getState().loadedAt).not.toBeNull()
  } finally {
    consoleError.mockRestore()
  }
})

it('does not publish an old workspace failure after the active workspace changes', async () => {
  fixture.workspaceId = 'workspace-a'
  fixture.invoke.mockReset()
  let rejectOldLoad: ((error: Error) => void) | undefined
  const oldRows = new Promise<unknown[]>((_resolve, reject) => {
    rejectOldLoad = reject
  })
  fixture.invoke.mockImplementation((_channel: string, input: { workspaceId: string }) =>
    input.workspaceId === 'workspace-a' ? oldRows : []
  )
  useTaskBoardStore.setState({ tasks: [], loadedAt: null, error: null, loading: false })
  const oldLoad = useTaskBoardStore.getState().load()
  await vi.waitFor(() => expect(fixture.invoke).toHaveBeenCalledTimes(1))

  fixture.workspaceId = 'workspace-b'
  await useTaskBoardStore.getState().load()
  rejectOldLoad?.(new Error('previous workspace failure'))
  await oldLoad
  expect(useTaskBoardStore.getState().error).toBeNull()
  expect(useTaskBoardStore.getState().loading).toBe(false)
  expect(useTaskBoardStore.getState().tasks).toEqual([])
})
