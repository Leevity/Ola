import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { deleteTeamRuntime } from '../runtime-client'
import { useTeamStore } from '@renderer/stores/team-store'

export const teamDeleteTool: ToolHandler = {
  definition: {
    name: 'TeamDelete',
    description:
      'Delete the active team and clean up all resources. Use this when all tasks are completed and the team is no longer needed.',
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
      await deleteTeamRuntime({ teamName: team.name })
      useTeamStore.setState({ activeTeam: null })
      return encodeStructuredToolResult({ success: true, teamName: team.name })
    } catch (error) {
      return encodeToolError(error instanceof Error ? error.message : String(error))
    }
  },
  requiresApproval: () => true
}
