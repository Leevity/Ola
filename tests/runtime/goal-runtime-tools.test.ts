import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  getGoal: vi.fn(),
  createGoal: vi.fn(),
  updateGoal: vi.fn()
}))

vi.mock('../../src/main/db/goals-dao', () => db)

import { createGoalRuntimeTools } from '../../src/main/runtime/goal-runtime-tools'
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
    toolNames: [],
    unattended: false
  },
  signal: new AbortController().signal
}

describe('Main TS goal runtime tools', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    db.getGoal.mockResolvedValue(undefined)
    db.createGoal.mockResolvedValue({
      session_id: 'session-a',
      goal_id: 'goal-a',
      objective: 'Ship the migration',
      status: 'active'
    })
    db.updateGoal.mockResolvedValue({
      session_id: 'session-a',
      goal_id: 'goal-a',
      status: 'complete'
    })
  })

  it('exposes the goal catalog and session-bound resource locks', async () => {
    const tools = createGoalRuntimeTools()
    expect(tools.map((tool) => tool.name)).toEqual(['get_goal', 'create_goal', 'update_goal'])
    await expect(tools[1].resources({}, context)).resolves.toEqual(['goal:workspace-a:session-a'])
  })

  it('validates the explicit goal contract', () => {
    const tools = createGoalRuntimeTools()
    expect(() => tools[1].validate({ objective: '' })).toThrow()
    expect(() => tools[1].validate({ objective: 'x', token_budget: 0 })).toThrow()
    expect(() => tools[2].validate({ status: 'active' })).toThrow()
  })

  it('creates only when the current session has no goal', async () => {
    const tools = createGoalRuntimeTools()
    const input = tools[1].validate({ objective: 'Ship the migration', token_budget: 1000 })
    const result = await tools[1].execute(input, context)
    expect(db.createGoal).toHaveBeenCalledWith({
      sessionId: 'session-a',
      workspaceId: 'workspace-a',
      objective: 'Ship the migration',
      tokenBudget: 1000
    })
    expect(result).toEqual(expect.objectContaining({ goal: expect.any(Object) }))

    db.getGoal.mockResolvedValue({ goal_id: 'goal-a', session_id: 'session-a' })
    await expect(tools[1].execute(input, context)).rejects.toThrow('GOAL_ALREADY_EXISTS')
  })

  it('only updates an existing goal to complete or blocked', async () => {
    const tools = createGoalRuntimeTools()
    db.getGoal.mockResolvedValue({ goal_id: 'goal-a', session_id: 'session-a' })
    const input = tools[2].validate({ status: 'complete' })
    await expect(tools[2].execute(input, context)).resolves.toEqual(
      expect.objectContaining({ goal: expect.any(Object) })
    )
    expect(db.updateGoal).toHaveBeenCalledWith('session-a', { status: 'complete' }, 'workspace-a')
  })
})
