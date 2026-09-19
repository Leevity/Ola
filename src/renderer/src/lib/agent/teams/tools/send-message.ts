import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { appendTeamRuntimeMessage } from '../runtime-client'
import { useTeamStore } from '@renderer/stores/team-store'
import type { TeamRuntimeMessageType } from '../../../../../../shared/team-runtime-types'

const MESSAGE_TYPES = new Set<TeamRuntimeMessageType>([
  'message',
  'broadcast',
  'shutdown_request',
  'shutdown_response',
  'idle_notification',
  'permission_request',
  'permission_response',
  'plan_approval_request',
  'plan_approval_response',
  'team_permission_update',
  'mode_set_request'
])

export const sendMessageTool: ToolHandler = {
  definition: {
    name: 'SendMessage',
    description:
      'Send a message to a teammate, broadcast to all teammates, or send a shutdown request. Use this for inter-agent communication within the team.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'message',
            'broadcast',
            'shutdown_request',
            'shutdown_response',
            'idle_notification',
            'permission_request',
            'permission_response',
            'plan_approval_request',
            'plan_approval_response',
            'team_permission_update',
            'mode_set_request'
          ],
          description:
            'Structured team message type. Use "message" for direct messages, "broadcast" for team-wide messages, and approval/protocol types for team coordination flows.'
        },
        recipient: {
          type: 'string',
          description:
            'Name of the recipient teammate (required for "message" and "shutdown_request")'
        },
        content: {
          type: 'string',
          description: 'Message content'
        },
        sender: {
          type: 'string',
          description: 'Your name as the sender (defaults to "lead")'
        },
        summary: {
          type: 'string',
          description: 'Optional short summary of the message'
        }
      },
      required: ['type', 'content']
    }
  },
  execute: async (input) => {
    const team = useTeamStore.getState().activeTeam
    if (!team?.name) return encodeToolError('No active team')
    const type = typeof input.type === 'string' ? input.type : ''
    const content = typeof input.content === 'string' ? input.content.trim() : ''
    if (!type) return encodeToolError('type is required')
    if (!MESSAGE_TYPES.has(type as TeamRuntimeMessageType))
      return encodeToolError(`Unsupported message type: ${type}`)
    if (!content) return encodeToolError('content is required')
    const recipient = typeof input.recipient === 'string' ? input.recipient.trim() : ''
    const to = type === 'broadcast' ? 'all' : recipient
    if (!to) return encodeToolError('recipient is required unless type is broadcast')
    try {
      const message = {
        id: crypto.randomUUID(),
        from:
          typeof input.sender === 'string' && input.sender.trim() ? input.sender.trim() : 'lead',
        to,
        type: type as TeamRuntimeMessageType,
        content,
        ...(typeof input.summary === 'string' && input.summary.trim()
          ? { summary: input.summary.trim() }
          : {}),
        timestamp: Date.now()
      }
      await appendTeamRuntimeMessage({ teamName: team.name, message })
      return encodeStructuredToolResult({ success: true, message })
    } catch (error) {
      return encodeToolError(error instanceof Error ? error.message : String(error))
    }
  },
  requiresApproval: () => false
}
