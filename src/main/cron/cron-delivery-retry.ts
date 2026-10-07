export interface CronDeliveryRetryAttempt {
  deliveryId: string
  pluginId: string
  chatId: string
  attemptNumber: number
}

export interface CronDeliveryRetryResult {
  success: true
  deliveryId: string
  retryOfId: string
  status: 'sent' | 'failed' | 'unknown'
  attemptNumber: number
  startedAt: number
  finishedAt: number
  errorCode: string | null
}

export async function executeCronDeliveryRetry(input: {
  runId: string
  workspaceId: string
  retryOfId: string
  content: string
  createIds: () => { deliveryId: string; toolCallId: string }
  now: () => number
  prepare: (args: {
    deliveryId: string
    runId: string
    retryOfId: string
    workspaceId: string
    toolCallId: string
    startedAt: number
  }) => Promise<CronDeliveryRetryAttempt>
  send: (
    attempt: CronDeliveryRetryAttempt,
    content: string
  ) => Promise<'sent' | 'failed' | 'unknown'>
  record: (args: {
    attempt: CronDeliveryRetryAttempt
    runId: string
    workspaceId: string
    retryOfId: string
    toolCallId: string
    startedAt: number
    finishedAt: number
    status: 'sent' | 'failed' | 'unknown'
    errorCode: string | null
  }) => Promise<void>
}): Promise<CronDeliveryRetryResult> {
  const { deliveryId, toolCallId } = input.createIds()
  const startedAt = input.now()
  const attempt = await input.prepare({
    deliveryId,
    runId: input.runId,
    retryOfId: input.retryOfId,
    workspaceId: input.workspaceId,
    toolCallId,
    startedAt
  })

  let status: CronDeliveryRetryResult['status'] = 'unknown'
  let errorCode: string | null = null
  try {
    status = await input.send(attempt, input.content)
    errorCode = status === 'failed' ? 'MANUAL_RETRY_REPORTED_FAILURE' : null
  } catch {
    errorCode = 'MANUAL_RETRY_RESULT_UNKNOWN'
  }

  const finishedAt = input.now()
  try {
    await input.record({
      attempt,
      runId: input.runId,
      workspaceId: input.workspaceId,
      retryOfId: input.retryOfId,
      toolCallId,
      startedAt,
      finishedAt,
      status,
      errorCode
    })
  } catch {
    status = 'unknown'
    errorCode = 'MANUAL_RETRY_RECORD_FAILED'
  }

  return {
    success: true,
    deliveryId: attempt.deliveryId,
    retryOfId: input.retryOfId,
    status,
    attemptNumber: attempt.attemptNumber,
    startedAt,
    finishedAt,
    errorCode
  }
}
