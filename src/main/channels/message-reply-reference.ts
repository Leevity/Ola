const REPLY_REFERENCE_PREFIX = 'ola-reply:'

export function encodeMessageReplyReference(chatId: string, messageId: string): string {
  if (!chatId || !messageId) return messageId
  const payload = JSON.stringify({ chatId, messageId })
  return `${REPLY_REFERENCE_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`
}

export function decodeMessageReplyReference(
  value: string
): { chatId: string; messageId: string } | null {
  if (!value.startsWith(REPLY_REFERENCE_PREFIX)) return null

  try {
    const payload = JSON.parse(
      Buffer.from(value.slice(REPLY_REFERENCE_PREFIX.length), 'base64url').toString('utf8')
    ) as { chatId?: unknown; messageId?: unknown }
    if (typeof payload.chatId !== 'string' || typeof payload.messageId !== 'string') return null
    if (!payload.chatId || !payload.messageId) return null
    return { chatId: payload.chatId, messageId: payload.messageId }
  } catch {
    return null
  }
}
