import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  getTask: vi.fn(),
  listTasksBySession: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn()
}))

vi.mock('../../src/main/db/tasks-dao', () => db)

import { createTaskRuntimeTools } from '../../src/main/runtime/task-runtime-tools'
import type { ToolContext } from '../../src/runtime/tools/tool-executor'

const context: ToolContext = {
  run: {
    runId: 'run-a',
    taskId: 'task-a',
    requestId: 'request-a',
    traceId: 'trace-a',
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    environmentId: 'local',
    modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
    prompt: 'test',
    unattended: false
  },
  signal: new AbortController().signal
}

describe('Main TS task runtime tools', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    db.listTasksBySession.mockResolvedValue([])
    db.getTask.mockResolvedValue(undefined)
    db.createTask.mockResolvedValue(undefined)
    db.updateTask.mockResolvedValue(undefined)
    db.deleteTask.mockResolvedValue(undefined)
  })

  it('exposes the task board catalog with workspace-bound write locks', async () => {
    const tools = createTaskRuntimeTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      'TaskList',
      'TaskGet',
      'TaskCreate',
      'TaskUpdate',
      'TaskDelete'
    ])
    expect(tools[2].effect).toBe('write')
    await expect(tools[2].resources({}, context)).resolves.toEqual(['tasks:workspace-a:session-a'])
    await expect(tools[0].resources({}, context)).resolves.toEqual([])
  })

  it('rejects malformed task input before touching persistence', () => {
    const tools = createTaskRuntimeTools()
    expect(() => tools[2].validate({ title: '' })).toThrow()
    expect(() => tools[3].validate({ taskId: 'task-a' })).toThrow()
    expect(() => tools[4].validate({})).toThrow()
    expect(db.createTask).not.toHaveBeenCalled()
  })

  it('creates a task only in the current session and returns the persisted row', async () => {
    const tools = createTaskRuntimeTools()
    db.getTask.mockResolvedValueOnce({
      id: 'task-created',
      session_id: 'session-a',
      subject: 'Ship it'
    })
    const input = tools[2].validate({
      title: 'Ship it',
      metadata: { priority: 'high' }
    })
    const result = await tools[2].execute(input, context)
    expect(db.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-a',
        workspaceId: 'workspace-a',
        subject: 'Ship it',
        sortOrder: 0
      })
    )
    expect(result).toEqual(expect.objectContaining({ id: 'task-created' }))
  })

  it('rejects a task from another session even when the workspace matches', async () => {
    const tools = createTaskRuntimeTools()
    db.getTask.mockResolvedValue({ id: 'task-other', session_id: 'session-b' })
    const input = tools[1].validate({ taskId: 'task-other' })
    await expect(tools[1].execute(input, context)).rejects.toThrow('TASK_NOT_FOUND')
  })
})
