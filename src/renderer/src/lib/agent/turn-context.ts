import type { ContentBlock, UnifiedMessage } from '../api/types'

export interface TurnContextOptions {
  planMode?: boolean
}

function buildTurnContextText(options: TurnContextOptions): string | null {
  if (!options.planMode) return null

  return [
    '<turn-context>',
    '<plan-mode>enabled; inspect and write plans only unless implementation is explicitly approved for this turn.</plan-mode>',
    '</turn-context>'
  ].join('\n')
}

function prependTextToContent(content: UnifiedMessage['content'], text: string): UnifiedMessage['content'] {
  if (typeof content === 'string') return `${text}\n\n${content}`

  const contextBlock: ContentBlock = { type: 'text', text }
  return [contextBlock, ...content]
}

export function prependTurnContextToLastUserMessage(
  messages: UnifiedMessage[],
  options: TurnContextOptions
): UnifiedMessage[] {
  const contextText = buildTurnContextText(options)
  if (!contextText) return messages

  const lastUserIndex = messages.reduce((index, message, currentIndex) => {
    return message.role === 'user' ? currentIndex : index
  }, -1)

  if (lastUserIndex < 0) return messages

  return messages.map((message, index) => {
    if (index !== lastUserIndex) return message
    return {
      ...message,
      content: prependTextToContent(message.content, contextText)
    }
  })
}
