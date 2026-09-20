import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_CLICK_TOOL_NAME } from './types'
import { IPC } from '@renderer/lib/ipc/channels'
import { encodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'

export const desktopClickTool: ToolHandler = {
  definition: {
    name: DESKTOP_CLICK_TOOL_NAME,
    description:
      'Click a desktop coordinate. Supports left/right/middle button with click, double_click, down, or up actions. Always inspect the screen first when possible.',
    inputSchema: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: 'Absolute X coordinate on the virtual desktop.'
        },
        y: {
          type: 'number',
          description: 'Absolute Y coordinate on the virtual desktop.'
        },
        button: {
          type: 'string',
          description: 'Mouse button: left, right, or middle.'
        },
        action: {
          type: 'string',
          description: 'Mouse action: click, double_click, down, or up.'
        }
      },
      required: ['x', 'y'],
      additionalProperties: false
    }
  },
  execute: async (input, ctx) =>
    encodeStructuredToolResult(
      (await ctx.ipc.invoke(IPC.DESKTOP_INPUT_CLICK, input)) as Record<string, unknown>
    ),
  requiresApproval: () => true
}
