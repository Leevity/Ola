import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { getTeamRuntimeSnapshot } from '../runtime-client'
import { useTeamStore } from '@renderer/stores/team-store'

/**
 * TeamStatus — non-blocking snapshot of the current team state.
 * Returns members, tasks, and recent messages without waiting.
 * Use this to check progress without waiting.
 */
export const teamStatusTool: ToolHandler = {
  definition: {
    name: 'TeamStatus',
    description:
      'Get a snapshot of the current team state: all members with their status, all tasks, and recent messages. Non-blocking — returns immediately. Use this to check progress without waiting.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async () => {
    const team = useTeamStore.getState().activeTeam
    if (!team?.name) return encodeToolError('No active team')
    try {
      const snapshot = await getTeamRuntimeSnapshot({ teamName: team.name, limit: 20 })
      if (!snapshot) return encodeToolError(`Team "${team.name}" does not exist`)
      useTeamStore.getState().syncRuntimeSnapshot(snapshot, team.sessionId)
      return encodeStructuredToolResult({ ...snapshot })
    } catch (error) {
      return encodeToolError(error instanceof Error ? error.message : String(error))
    }
  },
  requiresApproval: () => false
}
