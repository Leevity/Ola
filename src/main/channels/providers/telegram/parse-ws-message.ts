import type { ChannelIncomingMessageData } from '../../channel-types'
import { encodeMessageReplyReference } from '../../message-reply-reference'

/**
 * Parse a Telegram WebSocket message frame into normalized data.
 * Supports Telegram Bot API update format and simple JSON envelope.
 */
export function parseTelegramWsMessage(raw: string): ChannelIncomingMessageData | null {
  try {
    const data = JSON.parse(raw)

    // Telegram Bot API update format (from relay)
    if (data.message) {
      const msg = data.message
      // Telegram date is Unix timestamp in seconds, convert to milliseconds
      const timestamp = msg.date ? msg.date * 1000 : Date.now()

      return {
        chatId: String(msg.chat?.id ?? ''),
        senderId: String(msg.from?.id ?? ''),
        senderName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || '',
        content: msg.text ?? '',
        messageId: encodeMessageReplyReference(
          String(msg.chat?.id ?? ''),
          String(msg.message_id ?? '')
        ),
        timestamp
      }
    }

    // Simple JSON envelope format
    if (data.chatId && data.content) {
      return {
        chatId: data.chatId,
        senderId: data.senderId ?? '',
        senderName: data.senderName ?? '',
        content: data.content,
        messageId: encodeMessageReplyReference(data.chatId, data.messageId ?? ''),
        timestamp: data.timestamp ?? Date.now()
      }
    }

    return null
  } catch {
    return null
  }
}
