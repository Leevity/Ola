import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_SCREENSHOT_TOOL_NAME } from './types'
import { IPC } from '@renderer/lib/ipc/channels'
import { encodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'

export const desktopScreenshotTool: ToolHandler = {
  definition: {
    name: DESKTOP_SCREENSHOT_TOOL_NAME,
    description:
      'Capture a full desktop screenshot and return it to the agent. Use this before mouse or keyboard actions when the current screen state matters.',
    inputSchema: {
      type: 'object',
      properties: {
        delayMs: {
          type: 'number',
          description: 'Optional delay in milliseconds before capturing the screenshot.'
        }
      },
      additionalProperties: false
    }
  },
  execute: async (input, ctx) => {
    const delayMs =
      typeof input.delayMs === 'number' ? Math.max(0, Math.min(input.delayMs, 30_000)) : 0
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs)
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new Error('Desktop screenshot cancelled'))
          },
          { once: true }
        )
      })
    }
    return encodeStructuredToolResult(
      (await ctx.ipc.invoke(IPC.DESKTOP_SCREENSHOT_CAPTURE)) as Record<string, unknown>
    )
  },
  requiresApproval: () => true
}
