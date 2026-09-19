import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'
import { usePlanStore } from '@renderer/stores/plan-store'
import { useUIStore } from '@renderer/stores/ui-store'

function sessionIdFor(ctx: Parameters<ToolHandler['execute']>[1]): string | null {
  const sessionId = ctx.sessionId?.trim()
  return sessionId || null
}

export function createPlanModeInlineToolHandlers(): Record<string, ToolHandler> {
  return {}
}

const enterPlanModeHandler: ToolHandler = {
  definition: {
    name: 'EnterPlanMode',
    description:
      'Enter Plan Mode to explore the codebase and create a detailed implementation plan before writing code. ' +
      'In plan mode, prioritize read/search tools for investigation and write the plan into the current plan file returned by this tool. ' +
      'Write operations remain available when the planning work needs them.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'Brief reason in English for entering plan mode. This becomes the initial plan title if no plan exists (e.g. "add-user-authentication").'
        }
      }
    }
  },
  execute: async (input, ctx) => {
    const sessionId = sessionIdFor(ctx)
    if (!sessionId) return encodeToolError('A session is required to enter plan mode')
    const existing = await usePlanStore.getState().loadPlanForSession(sessionId, true)
    if (existing && existing.status !== 'rejected' && existing.status !== 'completed') {
      usePlanStore.getState().setActivePlan(existing.id)
      useUIStore.getState().enterPlanMode(sessionId)
      return encodeStructuredToolResult({ plan: { ...existing }, reused: true })
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    const title = reason || 'Implementation plan'
    const plan = usePlanStore.getState().createPlan(sessionId, title, { status: 'drafting' })
    usePlanStore.getState().setActivePlan(plan.id)
    useUIStore.getState().enterPlanMode(sessionId)
    return encodeStructuredToolResult({ plan: { ...plan }, reused: false })
  },
  requiresApproval: () => false
}

const exitPlanModeHandler: ToolHandler = {
  definition: {
    name: 'ExitPlanMode',
    description:
      'Exit Plan Mode after writing the plan file. This signals that the plan is finalized and ready for user review. ' +
      'After calling this tool, you MUST STOP and wait for the user to review the plan; do NOT continue with any further actions.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async (_input, ctx) => {
    const sessionId = sessionIdFor(ctx)
    if (!sessionId) return encodeToolError('A session is required to exit plan mode')
    const plan =
      usePlanStore.getState().getPlanBySession(sessionId) ??
      (await usePlanStore.getState().loadPlanForSession(sessionId, true))
    if (!plan) return encodeToolError('No plan exists for this session')
    if (!plan.filePath && !plan.content)
      return encodeToolError('Write the plan file before exiting Plan Mode')
    usePlanStore.getState().updatePlan(plan.id, { status: 'awaiting_review' })
    usePlanStore.getState().setActivePlan(plan.id)
    useUIStore.getState().exitPlanMode(sessionId)
    return encodeStructuredToolResult({ plan: { ...plan, status: 'awaiting_review' } })
  },
  requiresApproval: () => false
}

export const PLAN_MODE_ALLOWED_TOOLS = new Set([
  'Read',
  'LS',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'Task',
  'Agent',
  'get_goal',
  'create_goal',
  'update_goal',
  'visualize_show_widget'
])

export const ACP_MODE_ALLOWED_TOOLS = new Set([
  'Read',
  'LS',
  'Glob',
  'Grep',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'Task',
  'Agent',
  'get_goal',
  'create_goal',
  'update_goal',
  'visualize_show_widget'
])

export function registerPlanTools(): void {
  toolRegistry.register(enterPlanModeHandler)
  toolRegistry.register(exitPlanModeHandler)
}
