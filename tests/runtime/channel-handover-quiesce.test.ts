import { expect, it } from 'vitest'
import { ChannelManager } from '../../src/main/channels/channel-manager'
import type {
  ChannelEvent,
  ChannelInstance,
  MessagingChannelService
} from '../../src/main/channels/channel-types'

const instance: ChannelInstance = {
  id: 'channel-a',
  type: 'test',
  name: 'Test channel',
  enabled: true,
  config: {},
  createdAt: 1
}

it('waits for an in-flight channel start, then stops inbound events before handover', async () => {
  const manager = new ChannelManager()
  let releaseStart!: () => void
  let started = false
  let stopped = false
  manager.registerFactory(
    'test',
    () =>
      ({
        start: async () => {
          started = true
          await new Promise<void>((resolve) => {
            releaseStart = resolve
          })
        },
        stop: async () => {
          stopped = true
        }
      }) as unknown as MessagingChannelService
  )
  const start = manager.startPlugin(instance, () => undefined)
  await expect.poll(() => started).toBe(true)
  const handover = manager.quiesceForHandover()
  await expect(manager.startPlugin(instance, () => undefined)).rejects.toThrow(
    'CHANNEL_HANDOVER_QUIESCED'
  )
  expect(stopped).toBe(false)
  releaseStart()
  await start
  await handover
  expect(stopped).toBe(true)
  expect(manager.getStatus(instance.id)).toBe('stopped')
})

it('fails closed if a channel provider cannot stop cleanly', async () => {
  const manager = new ChannelManager()
  manager.registerFactory(
    'test',
    () =>
      ({
        start: async () => undefined,
        stop: async () => {
          throw new Error('socket still active')
        }
      }) as unknown as MessagingChannelService
  )
  await manager.startPlugin(instance, () => undefined)
  await expect(manager.quiesceForHandover()).rejects.toThrow('CHANNEL_HANDOVER_STOP_FAILED')
  expect(manager.getService(instance.id)).toBeDefined()
  await expect(manager.startPlugin(instance, () => undefined)).rejects.toThrow(
    'CHANNEL_HANDOVER_QUIESCED'
  )
})

it('retains a failed-stop provider and refuses to replace its potentially live connection', async () => {
  const manager = new ChannelManager()
  let created = 0
  manager.registerFactory('test', () => {
    created++
    return {
      start: async () => undefined,
      stop: async () => {
        throw new Error('socket still active')
      }
    } as unknown as MessagingChannelService
  })
  await manager.startPlugin(instance, () => undefined)
  await expect(manager.startPlugin(instance, () => undefined)).rejects.toThrow(
    'socket still active'
  )
  expect(created).toBe(1)
  expect(manager.getService(instance.id)).toBeDefined()
  expect(manager.getStatus(instance.id)).toBe('error')
  await expect(manager.quiesceForHandover()).rejects.toThrow('CHANNEL_HANDOVER_STOP_FAILED')
})

it('keeps a partially started provider visible when cleanup also fails', async () => {
  const manager = new ChannelManager()
  manager.registerFactory(
    'test',
    () =>
      ({
        start: async () => {
          throw new Error('start failed')
        },
        stop: async () => {
          throw new Error('cleanup failed')
        }
      }) as unknown as MessagingChannelService
  )
  await expect(manager.startPlugin(instance, () => undefined)).rejects.toThrow('start failed')
  expect(manager.getService(instance.id)).toBeDefined()
  await expect(manager.quiesceForHandover()).rejects.toThrow('CHANNEL_HANDOVER_STOP_FAILED')
})

it('times out a stuck start without admitting late provider events', async () => {
  const manager = new ChannelManager()
  let releaseStart!: () => void
  let emit!: (event: ChannelEvent) => void
  let notified = 0
  manager.registerFactory('test', (_, notify) => {
    emit = notify
    return {
      start: async () => {
        await new Promise<void>((resolve) => {
          releaseStart = resolve
        })
      },
      stop: async () => undefined
    } as unknown as MessagingChannelService
  })
  const start = manager.startPlugin(instance, () => notified++)
  await expect.poll(() => releaseStart).toBeTypeOf('function')
  await expect(manager.quiesceForHandover(20)).rejects.toThrow('CHANNEL_HANDOVER_STOP_TIMEOUT')
  emit({ type: 'incoming_message', pluginId: instance.id, pluginType: 'test', data: {} })
  expect(notified).toBe(0)
  await expect(manager.startPlugin(instance, () => undefined)).rejects.toThrow(
    'CHANNEL_HANDOVER_QUIESCED'
  )
  releaseStart()
  await start
})

it('times out a stuck stop and keeps the provider visible until it actually stops', async () => {
  const manager = new ChannelManager()
  let releaseStop!: () => void
  manager.registerFactory(
    'test',
    () =>
      ({
        start: async () => undefined,
        stop: async () => {
          await new Promise<void>((resolve) => {
            releaseStop = resolve
          })
        }
      }) as unknown as MessagingChannelService
  )
  await manager.startPlugin(instance, () => undefined)
  await expect(manager.quiesceForHandover(20)).rejects.toThrow('CHANNEL_HANDOVER_STOP_TIMEOUT')
  expect(manager.getService(instance.id)).toBeDefined()
  releaseStop()
  await expect.poll(() => manager.getService(instance.id)).toBeUndefined()
})

it('keeps a successfully quiesced provider resumable behind an explicit resume call', async () => {
  const manager = new ChannelManager()
  let starts = 0
  let stops = 0
  let notified = 0
  let emit!: (event: ChannelEvent) => void
  manager.registerFactory('test', (_, notify) => {
    emit = notify
    return {
      start: async () => {
        starts++
      },
      stop: async () => {
        stops++
      }
    } as unknown as MessagingChannelService
  })

  await manager.startPlugin(instance, () => notified++)
  await manager.quiesceForHandover()
  expect(starts).toBe(1)
  expect(stops).toBe(1)
  expect(manager.getService(instance.id)).toBeUndefined()

  // Handover isolation is sticky until an explicit resume operation.
  await manager.resumeAfterHandover()
  expect(starts).toBe(2)
  expect(manager.getStatus(instance.id)).toBe('running')
  emit({ type: 'incoming_message', pluginId: instance.id, pluginType: 'test', data: {} })
  expect(notified).toBe(1)
})
