import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_TYPE_TOOL_NAME } from './types'
import { IPC } from '@renderer/lib/ipc/channels'
import { encodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'

export const desktopTypeTool: ToolHandler = {
  definition: {
    name: DESKTOP_TYPE_TOOL_NAME,
    description:
      'Type text, press a special key, or send a keyboard shortcut on the desktop. Supported hotkey modifiers: Control, Meta, Alt, Shift.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Type a full text string into the active desktop target.'
        },
        key: {
          type: 'string',
          description: 'Press one special key such as Enter, Tab, Escape, Backspace, or Arrow keys.'
        },
        hotkey: {
          type: 'array',
          description: 'A key chord like ["Control", "L"] or ["Meta", "Shift", "S"].',
          items: {
            type: 'string'
          }
        }
      }
    }
  },
  execute: async (input, ctx) =>
    encodeStructuredToolResult(
      (await ctx.ipc.invoke(IPC.DESKTOP_INPUT_TYPE, input)) as Record<string, unknown>
    ),
  requiresApproval: () => true
}
