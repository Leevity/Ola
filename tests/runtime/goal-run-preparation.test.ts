import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  reads: [] as Array<{ sessionId: string; workspaceId?: string }>,
  runStates: [] as Array<{ active: boolean; reason: string }>,
  updates: [] as Array<{ sessionId: string; workspaceId: string; status: string }>,
  events: [] as Array<{ sessionId: string; workspaceId: string; eventType: string }>
}))

vi.mock('../../src/main/db/goals-dao', () => ({
  getGoal: async (sessionId: string, workspaceId?: string) => {
    state.reads.push({ sessionId, workspaceId })
    return {
      session_id: sessionId,
      goal_id: 'goal-a',
      objective: 'Finish the migration',
      status: 'active',
      token_budget: 100,
      tokens_used: 0,
      time_used_seconds: 0,
      created_at: 1,
      updated_at: 1
    }
  },
  updateGoal: async (sessionId: string, patch: { status: string }, workspaceId: string) => {
    state.updates.push({ sessionId, workspaceId, status: patch.status })
    return {
      session_id: sessionId,
      goal_id: 'goal-a',
      objective: 'Finish the migration',
      status: patch.status,
      token_budget: 100,
      tokens_used: 0,
      time_used_seconds: 0,
      created_at: 1,
      updated_at: 1
    }
  },
  addGoalEvent: async (args: { sessionId: string; workspaceId: string; eventType: string }) => {
    state.events.push({
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      eventType: args.eventType
    })
    return { id: 'event-a', session_id: args.sessionId, event_type: args.eventType }
  }
}))
vi.mock('../../src/main/goals/goal-sync', () => ({
  emitGoalRunState: (args: { active: boolean; reason: string }) => state.runStates.push(args),
  emitGoalContinueRequested: () => undefined,
  emitGoalEventAdded: () => undefined,
  emitGoalUpdated: () => undefined
}))

import { GoalRuntimeService } from '../../src/main/goals/goal-runtime'

beforeEach(() => {
  state.reads.length = 0
  state.runStates.length = 0
  state.updates.length = 0
  state.events.length = 0
})

it('passes the authorized workspace to Goal reads and discards an unadmitted run', async () => {
  const runtime = new GoalRuntimeService()
  const messages = await runtime.prepareRun({
    runId: 'run-a',
    sessionId: 'session-a',
    workspaceId: 'team-a',
    messages: [],
    enqueueMessages: () => undefined
  })
  expect(messages.length).toBeGreaterThan(0)
  expect(state.reads).toEqual([{ sessionId: 'session-a', workspaceId: 'team-a' }])
  expect(runtime.hasRun('run-a')).toBe(true)
  runtime.discardPreparedRun('run-a')
  expect(runtime.hasRun('run-a')).toBe(false)
  expect(state.runStates).toMatchObject([
    { active: true, reason: 'run-started' },
    { active: false, reason: 'run-preparation-discarded' }
  ])
  await expect(runtime.finalizeRun('run-a')).resolves.toEqual({ requestContinue: false })

  await runtime.handleGoalMutation({
    sessionId: 'session-a',
    nextGoal: {
      session_id: 'session-a',
      goal_id: 'goal-a',
      objective: 'Finish the migration',
      status: 'active',
      token_budget: 100,
      tokens_used: 0,
      time_used_seconds: 0,
      created_at: 1,
      updated_at: 1
    },
    reason: 'created'
  })
  const prepare = (runId: string) =>
    runtime.prepareRun({
      runId,
      sessionId: 'session-a',
      workspaceId: 'team-a',
      messages: [],
      enqueueMessages: () => undefined
    })
  expect(JSON.stringify(await prepare('run-b'))).toContain(
    'Continue working toward the active session goal.'
  )
  runtime.discardPreparedRun('run-b')
  expect(JSON.stringify(await prepare('run-c'))).toContain(
    'Continue working toward the active session goal.'
  )
  runtime.discardPreparedRun('run-c')
})

it('keeps the authorized workspace on an aborted run status and event write', async () => {
  const runtime = new GoalRuntimeService()
  await runtime.prepareRun({
    runId: 'run-aborted',
    sessionId: 'session-a',
    workspaceId: 'team-a',
    messages: [],
    enqueueMessages: () => undefined
  })
  await runtime.observeEvent('run-aborted', { type: 'loop_end', reason: 'aborted' })
  await runtime.finalizeRun('run-aborted')
  expect(state.updates).toEqual([
    { sessionId: 'session-a', workspaceId: 'team-a', status: 'paused' }
  ])
  expect(state.events).toEqual([
    { sessionId: 'session-a', workspaceId: 'team-a', eventType: 'stall_paused' }
  ])
  expect(state.reads.every((read) => read.workspaceId === 'team-a')).toBe(true)
})
