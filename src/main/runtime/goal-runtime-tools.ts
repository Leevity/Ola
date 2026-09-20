import { createGoal, getGoal, updateGoal, type SessionGoalStatus } from '../db/goals-dao'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'

const MAX_OBJECTIVE = 64 * 1024

function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function sessionResource(context: { run: { workspaceId: string; sessionId: string } }): string {
  return `goal:${context.run.workspaceId}:${context.run.sessionId}`
}

export function createGoalRuntimeTools(): ToolDefinition[] {
  const get: ToolDefinition = {
    name: 'get_goal',
    description:
      'Get the current goal for this session, including status, budget, token usage, and elapsed time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: 'read',
    validate: (value) => {
      inputObject(value)
      return {}
    },
    resources: async () => [],
    execute: async (_value, context) => {
      const goal = await getGoal(context.run.sessionId, context.run.workspaceId)
      return goal ? { goal } : { goal: null, message: 'No active goal for this session' }
    }
  }

  const create: ToolDefinition = {
    name: 'create_goal',
    description:
      'Create a goal only when explicitly requested. Fails if this session already has a goal.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', minLength: 1, maxLength: MAX_OBJECTIVE },
        token_budget: { type: 'number', exclusiveMinimum: 0 }
      },
      required: ['objective'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      const item = inputObject(value)
      const objective = typeof item.objective === 'string' ? item.objective.trim() : ''
      const tokenBudget = item.token_budget
      if (
        !objective ||
        objective.length > MAX_OBJECTIVE ||
        (tokenBudget !== undefined &&
          (typeof tokenBudget !== 'number' || !Number.isFinite(tokenBudget) || tokenBudget <= 0))
      )
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return {
        objective,
        ...(tokenBudget === undefined ? {} : { tokenBudget })
      }
    },
    resources: async (_value, context) => [sessionResource(context)],
    execute: async (value, context) => {
      const current = await getGoal(context.run.sessionId, context.run.workspaceId)
      if (current) throw new RuntimeError('GOAL_ALREADY_EXISTS')
      const input = value as { objective: string; tokenBudget?: number }
      const goal = await createGoal({
        sessionId: context.run.sessionId,
        workspaceId: context.run.workspaceId,
        objective: input.objective,
        tokenBudget: input.tokenBudget
      })
      if (!goal) throw new RuntimeError('GOAL_NOT_CREATED')
      return { goal }
    }
  }

  const update: ToolDefinition = {
    name: 'update_goal',
    description:
      'Update the existing goal. Use complete only when all required work is done, or blocked only after the same blocker recurs three times.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['complete', 'blocked'] } },
      required: ['status'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      const status = inputObject(value).status
      if (status !== 'complete' && status !== 'blocked')
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return { status }
    },
    resources: async (_value, context) => [sessionResource(context)],
    execute: async (value, context) => {
      const current = await getGoal(context.run.sessionId, context.run.workspaceId)
      if (!current) throw new RuntimeError('GOAL_NOT_FOUND')
      const status = (value as { status: 'complete' | 'blocked' }).status as SessionGoalStatus
      const goal = await updateGoal(context.run.sessionId, { status }, context.run.workspaceId)
      if (!goal) throw new RuntimeError('GOAL_NOT_UPDATED')
      return { goal }
    }
  }

  return [get, create, update]
}
