import assert from 'node:assert/strict'
import { ChannelManager } from '../src/main/channels/channel-manager.ts'
import type {
  ChannelEvent,
  ChannelInstance,
  MessagingChannelService
} from '../src/main/channels/channel-types.ts'

const instance = (id: string): ChannelInstance => ({
  id,
  type: 'test',
  name: id,
  enabled: true,
  config: {},
  createdAt: 0
})

let now = 1_000
const received: ChannelEvent[] = []
const manager = new ChannelManager({
  messageDedupTtlMs: 100,
  messageDedupMaxPerPlugin: 2,
  now: () => now
})

manager.registerFactory('test', (_instance, notify) => {
  const service: MessagingChannelService = {
    pluginId: _instance.id,
    pluginType: _instance.type,
    async start() {
      const event = (messageId: string): ChannelEvent => ({
        type: 'incoming_message',
        pluginId: _instance.id,
        pluginType: _instance.type,
        data: {
          messageId,
          chatId: 'chat',
          senderId: 'sender',
          senderName: 'Sender',
          content: 'Hello'
        }
      })
      notify(event('replayed'))
      notify(event('replayed'))
      notify(event(''))
      notify(event(''))
    },
    async stop() {
      await Promise.resolve()
    },
    isRunning: () => true,
    async sendMessage() {
      return { messageId: '' }
    },
    async replyMessage() {
      return { messageId: '' }
    },
    async getGroupMessages() {
      return []
    },
    async listGroups() {
      return []
    }
  }
  return service
})

await manager.startPlugin(instance('one'), (event) => received.push(event))
assert.equal(
  received.length,
  3,
  'duplicate non-empty message ids are suppressed; empty ids pass through'
)

await manager.stopPlugin('one')
await manager.startPlugin(instance('one'), (event) => received.push(event))
assert.equal(received.length, 5, 'a restart does not replay an already-seen message id')

now = 1_101
await manager.stopPlugin('one')
await manager.startPlugin(instance('one'), (event) => received.push(event))
assert.equal(received.length, 8, 'an expired message id is accepted again')

await manager.startPlugin(instance('two'), (event) => received.push(event))
assert.equal(received.length, 11, 'deduplication is scoped to the channel instance')

console.log('channel message dedup verification passed')
