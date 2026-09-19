import { expect, it } from 'vitest'
import {
  completeDurableChannelTask,
  hasChannelDeliveryReceipt
} from '../../src/renderer/src/lib/channel/durable-channel-task'

it('keeps a delivered task unacknowledged until its Agent turn completes', async () => {
  let finish!: () => void
  let acknowledged = 0
  const pending = completeDurableChannelTask(
    async () =>
      await new Promise<void>((resolve) => {
        finish = resolve
      }),
    () => {
      acknowledged++
    }
  )
  expect(acknowledged).toBe(0)
  finish()
  await pending
  expect(acknowledged).toBe(1)
})

it('leaves a failed task replayable instead of acknowledging it', async () => {
  let acknowledged = 0
  await expect(
    completeDurableChannelTask(
      async () => {
        throw new Error('Agent did not start')
      },
      () => {
        acknowledged++
      }
    )
  ).rejects.toThrow('Agent did not start')
  expect(acknowledged).toBe(0)
})

it('requires a provider receipt before a channel send can be considered delivered', () => {
  expect(hasChannelDeliveryReceipt({ messageId: 'remote-1' })).toBe(true)
  expect(hasChannelDeliveryReceipt({ messageId: '' })).toBe(true)
  expect(hasChannelDeliveryReceipt(undefined)).toBe(false)
  expect(hasChannelDeliveryReceipt({ success: false, error: 'rejected' })).toBe(false)
  expect(hasChannelDeliveryReceipt({ messageId: null })).toBe(false)
})
