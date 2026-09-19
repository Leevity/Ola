import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'
import { useGoalStore } from '@renderer/stores/goal-store'

function requireSessionId(ctx: Parameters<ToolHandler['execute']>[1]): string | null {
  const sessionId = ctx.sessionId?.trim()
  return sessionId || null
}

const getGoalHandler: ToolHandler = {
  definition: {
    name: 'get_goal',
    description:
      'Get the current goal for this session, including status, budgets, token and elapsed-time usage, and remaining token budget.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async (_input, ctx) => {
    const sessionId = requireSessionId(ctx)
    if (!sessionId) return encodeToolError('A session is required to read the current goal')
    const goal =
      useGoalStore.getState().getGoalBySession(sessionId) ??
      (await useGoalStore.getState().loadGoalForSession(sessionId, true))
    return encodeStructuredToolResult({
      goal: goal ?? null,
      ...(goal ? {} : { message: 'No active goal for this session' })
    })
  },
  requiresApproval: () => false
}

const createGoalHandler: ToolHandler = {
  definition: {
    name: 'create_goal',
    description:
      'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if a goal exists; use update_goal only for status.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description:
            'Required. The concrete objective to start pursuing. This starts a new active goal only when no goal is currently defined; if a goal already exists, this tool fails.'
        },
        token_budget: {
          type: 'number',
          description: 'Optional positive token budget for the new active goal.'
        }
      },
      required: ['objective']
    }
  },
  execute: async (input, ctx) => {
    const sessionId = requireSessionId(ctx)
    if (!sessionId) return encodeToolError('A session is required to create a goal')
    const objective = typeof input.objective === 'string' ? input.objective.trim() : ''
    if (!objective) return encodeToolError('objective is required')
    const tokenBudget = input.token_budget
    if (
      tokenBudget !== undefined &&
      (typeof tokenBudget !== 'number' || !Number.isFinite(tokenBudget) || tokenBudget <= 0)
    )
      return encodeToolError('token_budget must be a positive number when provided')
    const result = await useGoalStore.getState().createGoal({
      sessionId,
      objective,
      tokenBudget: tokenBudget as number | undefined
    })
    return result.success
      ? encodeStructuredToolResult({ goal: result.goal })
      : encodeToolError(result.error ?? 'Goal was not created')
  },
  requiresApproval: () => false
}

const updateGoalHandler: ToolHandler = {
  definition: {
    name: 'update_goal',
    description:
      'Update the existing goal. Use this tool only to mark the goal achieved or genuinely blocked. Set status to complete only when the objective is achieved and no required work remains. Set status to blocked only after the same blocking condition has recurred for at least three consecutive goal turns and the agent cannot make meaningful progress without user input or an external-state change. Do not use blocked merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification. You cannot use this tool to pause, resume, or limit a goal; those status changes are controlled by the user or system. The runtime may defer completion if the run still has unfinished tasks, failed or unfinished tool calls, queued user messages, or an active Plan Mode gate. When marking a budgeted goal achieved with status complete, report the final token usage from the tool result to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['complete', 'blocked'],
          description:
            'Required. Set to complete only when the objective is achieved and no required work remains. Set to blocked only after the same blocking condition has recurred for at least three consecutive goal turns.'
        }
      },
      required: ['status']
    }
  },
  execute: async (input, ctx) => {
    const sessionId = requireSessionId(ctx)
    if (!sessionId) return encodeToolError('A session is required to update a goal')
    const status = input.status
    if (status !== 'complete' && status !== 'blocked')
      return encodeToolError('status must be complete or blocked')
    const result = await useGoalStore.getState().updateGoal(sessionId, { status })
    return result.success
      ? encodeStructuredToolResult({ goal: result.goal })
      : encodeToolError(result.error ?? 'Goal was not updated')
  },
  requiresApproval: () => false
}

export function registerGoalTools(): void {
  toolRegistry.register(getGoalHandler)
  toolRegistry.register(createGoalHandler)
  toolRegistry.register(updateGoalHandler)
}
