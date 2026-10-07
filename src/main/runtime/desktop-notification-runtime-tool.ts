import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'
import { trackCronDelivery } from '../cron/cron-delivery-tracking'

export type DesktopNotificationDelivery = (
  title: string,
  body: string
) => Promise<'shown' | 'failed' | 'unknown'>

type NotifyInput = { title: string; body: string; type?: string; duration?: number }

function input(value: unknown): NotifyInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => !['title', 'body', 'type', 'duration'].includes(key)))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (
    typeof item.title !== 'string' ||
    !item.title.trim() ||
    item.title.length > 512 ||
    typeof item.body !== 'string' ||
    !item.body.trim() ||
    item.body.length > 8 * 1024 ||
    (item.type !== undefined && typeof item.type !== 'string') ||
    (item.duration !== undefined &&
      (typeof item.duration !== 'number' ||
        !Number.isSafeInteger(item.duration) ||
        item.duration < 0 ||
        item.duration > 60_000))
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return {
    title: item.title.trim(),
    body: item.body.trim(),
    ...(typeof item.type === 'string' ? { type: item.type } : {}),
    ...(typeof item.duration === 'number' ? { duration: item.duration } : {})
  }
}

/** Main-host adapter: the shared runtime never imports Electron notification APIs. */
export function createDesktopNotificationTool(
  deliver: DesktopNotificationDelivery
): ToolDefinition {
  return {
    name: 'Notify',
    description: 'Send a desktop notification to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        type: { type: 'string' },
        duration: { type: 'integer', minimum: 0, maximum: 60_000 }
      },
      required: ['title', 'body'],
      additionalProperties: false
    },
    effect: 'write',
    validate: input,
    resources: async () => ['desktop-notification'],
    execute: async (value, context) =>
      trackCronDelivery(context, 'desktop', async () => {
        const notification = value as NotifyInput
        const status = await deliver(notification.title, notification.body)
        if (status === 'failed') return { success: false, error: 'NOTIFICATION_FAILED' }
        if (status === 'unknown') return { status: 'unknown' }
        return { success: true, title: notification.title, body: notification.body.slice(0, 200) }
      })
  }
}
