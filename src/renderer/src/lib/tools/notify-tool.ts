import { toolRegistry } from '../agent/tool-registry'
import type { ToolHandler } from './tool-types'
import { IPC } from '../ipc/channels'

/**
 * Notify tool — sends desktop toast notifications and/or injects messages into sessions.
 * Designed for use by any agent (especially CronAgent) to surface results to the user.
 */

export interface NotifyToolInput {
  title: string
  body: string
  type?: 'info' | 'success' | 'warning' | 'error'
  duration?: number
}

/** Execute the desktop notification through the Main-owned TS IPC boundary. */
export async function executeNotifyTool(
  input: Record<string, unknown>,
  ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> }
): Promise<string> {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (!title || !body) return JSON.stringify({ error: 'Notify requires title and body.' })
  const type =
    input.type === 'success' || input.type === 'warning' || input.type === 'error'
      ? input.type
      : 'info'
  const duration =
    typeof input.duration === 'number' && Number.isFinite(input.duration)
      ? Math.min(60_000, Math.max(500, Math.trunc(input.duration)))
      : undefined
  const result = await ipc.invoke(IPC.NOTIFY_DESKTOP, { title, body, type, duration })
  if (result && typeof result === 'object' && 'success' in result && result.success === false)
    return JSON.stringify({ error: 'Desktop notification failed.' })
  return JSON.stringify({ success: true })
}

const notifyHandler: ToolHandler = {
  definition: {
    name: 'Notify',
    description:
      'Send a desktop notification to the user. Use this to surface results, alerts, or summaries.\n\n' +
      'This tool shows a non-intrusive toast notification in the app without adding to chat history.\n\n' +
      'Notification types control the visual style:\n' +
      '- "info": General information (blue)\n' +
      '- "success": Task completed successfully (green)\n' +
      '- "warning": Something needs attention (amber)\n' +
      '- "error": Something failed (red)',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Notification title (shown as the header)'
        },
        body: {
          type: 'string',
          description: 'Notification body — the main content/summary to communicate'
        },
        type: {
          type: 'string',
          enum: ['info', 'success', 'warning', 'error'],
          description: 'Notification style. Default: "info"'
        },
        duration: {
          type: 'number',
          description: 'How long the desktop toast stays visible in milliseconds. Default: 5000'
        }
      },
      required: ['title', 'body']
    }
  },

  execute: async (input, ctx) => executeNotifyTool(input, ctx.ipc),

  requiresApproval: () => false
}

export function registerNotifyTool(): void {
  toolRegistry.register(notifyHandler)
}
