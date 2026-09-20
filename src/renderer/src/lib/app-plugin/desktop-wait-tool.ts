import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_WAIT_TOOL_NAME } from './types'
import { encodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'

export const desktopWaitTool: ToolHandler = {
  definition: {
    name: DESKTOP_WAIT_TOOL_NAME,
    description: 'Pause desktop automation for a short period before continuing.',
    inputSchema: {
      type: 'object',
      properties: {
        delayMs: {
          type: 'number',
          description: 'Delay in milliseconds before continuing. Defaults to 2000.'
        }
      },
      additionalProperties: false
    }
  },
  execute: async (input, ctx) => {
    const delayMs =
      typeof input.delayMs === 'number' ? Math.max(0, Math.min(input.delayMs, 30_000)) : 2_000
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs)
      ctx.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('Desktop wait cancelled'))
        },
        { once: true }
      )
    })
    return encodeStructuredToolResult({ success: true, delayMs })
  },
  requiresApproval: () => true
}
