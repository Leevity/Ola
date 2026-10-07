import { recordCronDelivery } from '../db/cron-dao'
import type { ToolContext } from '../../runtime/tools/tool-executor'

type DeliveryKind = 'desktop' | 'channel'
type DeliveryStatus = 'sent' | 'failed' | 'unknown'

export function classifyCronDeliveryResult(value: unknown): DeliveryStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown'
  const result = value as Record<string, unknown>
  const positive =
    result.success === true ||
    result.ok === true ||
    (typeof result.messageId === 'string' && result.messageId.length > 0)
  const negative = result.success === false || typeof result.error === 'string'
  if (positive && negative) return 'unknown'
  if (negative) return 'failed'
  if (positive) return 'sent'
  return 'unknown'
}

/** Persists delivery around the actual side effect; never retries a send here. */
export async function trackCronDelivery<T>(
  context: ToolContext,
  kind: DeliveryKind,
  deliver: () => Promise<T>,
  target?: { pluginId: string; chatId: string }
): Promise<T> {
  if (!context.run?.taskId?.startsWith('cron:')) return deliver()
  const runId = context.run.runId
  const workspaceId = context.run.workspaceId
  const toolCallId = context.toolCallId
  if (!toolCallId) throw new Error('CRON_DELIVERY_TOOL_CALL_ID_REQUIRED')
  const startedAt = Date.now()
  const delivery = {
    runId,
    workspaceId,
    toolCallId,
    kind,
    startedAt,
    ...(target ? { pluginId: target.pluginId, chatId: target.chatId } : {})
  }
  await recordCronDelivery({ ...delivery, status: 'pending' })
  let result: T
  try {
    result = await deliver()
  } catch (error) {
    await recordCronDelivery({
      ...delivery,
      status: 'unknown',
      finishedAt: Date.now(),
      errorCode: 'DELIVERY_RESULT_UNKNOWN'
    }).catch((recordError) =>
      console.error('[CronDelivery] Failed to persist an unknown result', recordError)
    )
    throw error
  }
  const status = classifyCronDeliveryResult(result)
  await recordCronDelivery({
    ...delivery,
    status,
    finishedAt: Date.now(),
    errorCode: status === 'failed' ? 'DELIVERY_REPORTED_FAILURE' : null
  }).catch((error) => console.error('[CronDelivery] Failed to persist the result', error))
  return result
}
