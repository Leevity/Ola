import assert from 'node:assert/strict'
import {
  decodeMessageReplyReference,
  encodeMessageReplyReference
} from '../src/main/channels/message-reply-reference.ts'
import { parseDiscordWsMessage } from '../src/main/channels/providers/discord/parse-ws-message.ts'
import { parseTelegramWsMessage } from '../src/main/channels/providers/telegram/parse-ws-message.ts'

const direct = encodeMessageReplyReference('chat:with:separator', 'message/with/slash')
assert.deepEqual(decodeMessageReplyReference(direct), {
  chatId: 'chat:with:separator',
  messageId: 'message/with/slash'
})
assert.equal(decodeMessageReplyReference('plain-message-id'), null)
assert.equal(decodeMessageReplyReference('ola-reply:not-base64'), null)

const discord = parseDiscordWsMessage(
  JSON.stringify({
    t: 'MESSAGE_CREATE',
    d: {
      id: 'discord-message',
      channel_id: 'discord-channel',
      content: 'hello',
      author: { id: 'user', username: 'User' }
    }
  })
)
assert.ok(discord)
assert.deepEqual(decodeMessageReplyReference(discord.messageId), {
  chatId: 'discord-channel',
  messageId: 'discord-message'
})

const telegram = parseTelegramWsMessage(
  JSON.stringify({
    message: {
      message_id: 42,
      chat: { id: -100123 },
      text: 'hello',
      from: { id: 7, first_name: 'User' }
    }
  })
)
assert.ok(telegram)
assert.deepEqual(decodeMessageReplyReference(telegram.messageId), {
  chatId: '-100123',
  messageId: '42'
})

console.log('channel reply routing verification passed')
