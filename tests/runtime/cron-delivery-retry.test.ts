import { describe, expect, it, vi } from 'vitest'
import { executeCronDeliveryRetry } from '../../src/main/cron/cron-delivery-retry'

const persistedAttempt = {
  deliveryId: 'retry-delivery',
  pluginId: 'persisted-plugin',
  chatId: 'persisted-chat',
  attemptNumber: 2
}

function baseInput(overrides: Partial<Parameters<typeof executeCronDeliveryRetry>[0]> = {}) {
  const events: string[] = []
  const send = vi.fn(async (_attempt: typeof persistedAttempt, _content: string) => 'sent' as const)
  const record = vi.fn(
    async (_args: Parameters<Parameters<typeof executeCronDeliveryRetry>[0]['record']>[0]) => {}
  )
  const input: Parameters<typeof executeCronDeliveryRetry>[0] = {
    runId: 'run-1',
    workspaceId: 'workspace-1',
    retryOfId: 'original-delivery',
    content: 'Reviewed message body',
    createIds: () => ({ deliveryId: 'retry-delivery', toolCallId: 'retry-tool-call' }),
    now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(20),
    prepare: async (args) => {
      events.push('prepare')
      expect(args).toEqual({
        deliveryId: 'retry-delivery',
        runId: 'run-1',
        retryOfId: 'original-delivery',
        workspaceId: 'workspace-1',
        toolCallId: 'retry-tool-call',
        startedAt: 10
      })
      return persistedAttempt
    },
    send: async (attempt, content) => {
      events.push('send')
      return send(attempt, content)
    },
    record: async (args) => {
      await record(args)
      events.push('record')
    },
    ...overrides
  }
  return { input, events, send, record }
}

describe('Cron delivery retry orchestration', () => {
  it('persists the retry before sending to the database-owned target snapshot', async () => {
    const { input, events, send, record } = baseInput()
    const result = await executeCronDeliveryRetry(input)

    expect(events).toEqual(['prepare', 'send', 'record'])
    expect(send).toHaveBeenCalledWith(persistedAttempt, 'Reviewed message body')
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: persistedAttempt,
        status: 'sent',
        retryOfId: 'original-delivery',
        startedAt: 10,
        finishedAt: 20
      })
    )
    expect(result).toMatchObject({ success: true, status: 'sent', attemptNumber: 2 })
  })

  it('records a thrown channel send as unknown without automatically retrying', async () => {
    const { input, events, record } = baseInput({
      send: async () => {
        events.push('send')
        throw new Error('connection dropped after request dispatch')
      }
    })

    const result = await executeCronDeliveryRetry(input)

    expect(events).toEqual(['prepare', 'send', 'record'])
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unknown', errorCode: 'MANUAL_RETRY_RESULT_UNKNOWN' })
    )
    expect(result).toMatchObject({ status: 'unknown', errorCode: 'MANUAL_RETRY_RESULT_UNKNOWN' })
  })

  it('does not send when the pending retry cannot be persisted', async () => {
    const { input, send, record } = baseInput({
      prepare: async () => {
        throw new Error('database unavailable')
      }
    })

    await expect(executeCronDeliveryRetry(input)).rejects.toThrow('database unavailable')
    expect(send).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it('keeps a sent message visible as unknown when final status persistence fails', async () => {
    const { input, events } = baseInput({
      record: async () => {
        events.push('record')
        throw new Error('database unavailable after send')
      }
    })

    const result = await executeCronDeliveryRetry(input)

    expect(events).toEqual(['prepare', 'send', 'record'])
    expect(result).toMatchObject({ status: 'unknown', errorCode: 'MANUAL_RETRY_RECORD_FAILED' })
  })
})
