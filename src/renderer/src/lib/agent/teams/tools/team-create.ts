import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { createTeamRuntime, getTeamRuntimeSnapshot } from '../runtime-client'
import { useTeamStore } from '@renderer/stores/team-store'

export const teamCreateTool: ToolHandler = {
  definition: {
    name: 'TeamCreate',
    description:
      'Create a new agent team for parallel collaboration. Use this when a task benefits from multiple agents working simultaneously on different aspects.',
    inputSchema: {
      type: 'object',
      properties: {
        team_name: {
          type: 'string',
          description: 'Short, descriptive name for the team (e.g. "pr-review", "bug-fix-squad")'
        },
        description: {
          type: 'string',
          description: 'What this team is working on'
        },
        default_backend: {
          type: 'string',
          enum: ['in-process'],
          description: 'Optional default backend for teammate execution.'
        }
      },
      required: ['team_name', 'description']
    }
  },
  execute: async (input, ctx) => {
    const teamName = typeof input.team_name === 'string' ? input.team_name.trim() : ''
    const description = typeof input.description === 'string' ? input.description.trim() : ''
    if (!teamName) return encodeToolError('team_name is required')
    if (!description) return encodeToolError('description is required')
    try {
      const result = await createTeamRuntime({
        teamName,
        description,
        sessionId: ctx.sessionId ?? undefined,
        workingFolder: ctx.workingFolder,
        defaultBackend: 'in-process'
      })
      const snapshot = await getTeamRuntimeSnapshot({ teamName, limit: 10 })
      if (snapshot)
        useTeamStore.getState().syncRuntimeSnapshot(snapshot, ctx.sessionId ?? undefined)
      return encodeStructuredToolResult({ ...result })
    } catch (error) {
      return encodeToolError(error instanceof Error ? error.message : String(error))
    }
  },
  requiresApproval: () => false
}
