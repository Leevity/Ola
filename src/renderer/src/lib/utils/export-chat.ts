import type { ContentBlock, UnifiedMessage } from '../api/types'
import type { Session } from '../../stores/chat-store'
import { invokeMessagePackBinary } from '../ipc/messagepack-ipc-client'
import {
  formatCacheHitRate,
  getBillableInputTokens,
  getBillableTotalTokens,
  getCacheCreationTokens,
  getCacheHitRate
} from '../format-tokens'
import { parseSystemCommandTag } from '../commands/system-command'
import { stripSystemReminders } from '../image-attachments'
import {
  DB_MESSAGES_COUNT_MSGPACK_CHANNEL,
  DB_MESSAGES_LIST_PAGE_MSGPACK_CHANNEL
} from '../../../../shared/messagepack/binary-ipc'

interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  meta: string | null
  created_at: number
  usage: string | null
  sort_order: number
}

interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  reasoning: number
}

const EXPORT_MESSAGE_PAGE_SIZE = 500

function formatTextContent(text: string, removeSystemReminders = false): string {
  const visibleText = removeSystemReminders ? stripSystemReminders(text) : text
  if (!visibleText) return ''

  const parsed = parseSystemCommandTag(visibleText)
  if (!parsed) return visibleText

  const parts = [`**System Command: \`/${parsed.command.name}\`**`]
  if (parsed.command.content) {
    parts.push(parsed.command.content)
  }
  if (parsed.remainingText) {
    parts.push(parsed.remainingText)
  }
  return parts.join('\n\n')
}

function contentToMarkdown(
  content: string | ContentBlock[],
  removeSystemReminders = false
): string {
  if (typeof content === 'string') return formatTextContent(content, removeSystemReminders)

  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return formatTextContent(block.text, removeSystemReminders)
        case 'tool_use': {
          if (block.name === 'Task') {
            const inp = block.input as Record<string, unknown>
            const subType = String(inp.subagent_type ?? '?')
            const desc = String(inp.description ?? inp.prompt ?? '')
            return `**🧠 Task: \`${subType}\`** — ${desc}`
          }
          return `**Tool Call: \`${block.name}\`**\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\``
        }
        case 'tool_result': {
          let contentStr: string
          if (Array.isArray(block.content)) {
            const parts = block.content.map((cb) =>
              cb.type === 'text'
                ? cb.text
                : cb.type === 'image'
                  ? `[Image: ${cb.source.mediaType}]`
                  : ''
            )
            contentStr = parts.join('\n') || '[Image]'
          } else {
            contentStr = block.content
          }
          return `**Tool Result** (${block.isError ? 'error' : 'success'}):\n\`\`\`\n${contentStr}\n\`\`\``
        }
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join('\n\n')
}

function rowToMessage(row: MessageRow): UnifiedMessage {
  let content: UnifiedMessage['content']
  try {
    const parsed = JSON.parse(row.content)
    content = typeof parsed === 'string' || Array.isArray(parsed) ? parsed : row.content
  } catch {
    content = row.content
  }

  let meta: UnifiedMessage['meta']
  try {
    meta = row.meta ? (JSON.parse(row.meta) as UnifiedMessage['meta']) : undefined
  } catch {
    meta = undefined
  }

  return {
    id: row.id,
    role: row.role as UnifiedMessage['role'],
    content,
    ...(meta ? { meta } : {}),
    createdAt: row.created_at,
    usage: row.usage ? JSON.parse(row.usage) : undefined
  }
}

function appendSessionHeader(lines: string[], session: Session, messageCount: number): void {
  lines.push(`# ${session.title}`)
  lines.push('')
  lines.push(`- **Mode**: ${session.mode}`)
  lines.push(`- **Messages**: ${messageCount}`)
  lines.push(`- **Created**: ${new Date(session.createdAt).toLocaleString()}`)
  lines.push(`- **Updated**: ${new Date(session.updatedAt).toLocaleString()}`)
  if (session.workingFolder) {
    lines.push(`- **Working Folder**: \`${session.workingFolder}\``)
  }
  if (session.pinned) {
    lines.push(`- **Pinned**: Yes`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')
}

function appendMessageMarkdown(lines: string[], msg: UnifiedMessage, totals: TokenTotals): void {
  if (msg.role === 'system') return
  const label = msg.role === 'user' ? '## User' : '## Assistant'
  const time = new Date(msg.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })
  lines.push(`${label} <sub>${time}</sub>`)
  lines.push('')
  lines.push(contentToMarkdown(msg.content, msg.role === 'user'))
  if (msg.usage) {
    lines.push('')
    const extras: string[] = []
    const billableInput = getBillableInputTokens(msg.usage)
    if (msg.usage.cacheReadTokens) {
      const cacheTokenShare = getCacheHitRate(
        billableInput,
        msg.usage.cacheReadTokens,
        getCacheCreationTokens(msg.usage)
      )
      extras.push(`${msg.usage.cacheReadTokens} cached`)
      extras.push(`${formatCacheHitRate(cacheTokenShare)} cached token share`)
    }
    if (msg.usage.reasoningTokens) extras.push(`${msg.usage.reasoningTokens} reasoning`)
    lines.push(
      `<sub>Tokens: ${billableInput} in / ${msg.usage.outputTokens} out${extras.length > 0 ? ` / ${extras.join(' / ')}` : ''}</sub>`
    )

    totals.input += billableInput
    totals.output += msg.usage.outputTokens
    if (msg.usage.cacheReadTokens) totals.cacheRead += msg.usage.cacheReadTokens
    if (msg.usage.cacheCreationTokens) totals.cacheCreation += msg.usage.cacheCreationTokens
    if (msg.usage.reasoningTokens) totals.reasoning += msg.usage.reasoningTokens
  }
  lines.push('')
}

function appendTokenTotals(lines: string[], totals: TokenTotals): void {
  if (totals.input + totals.output > 0) {
    lines.push('---')
    lines.push('')
    const totalExtras: string[] = []
    if (totals.cacheRead > 0) {
      const cacheTokenShare = getCacheHitRate(totals.input, totals.cacheRead, totals.cacheCreation)
      totalExtras.push(`${totals.cacheRead} cache read`)
      totalExtras.push(`${formatCacheHitRate(cacheTokenShare)} cached token share`)
    }
    if (totals.cacheCreation > 0) totalExtras.push(`${totals.cacheCreation} cache write`)
    if (totals.reasoning > 0) totalExtras.push(`${totals.reasoning} reasoning`)
    lines.push(
      `**Total tokens**: ${getBillableTotalTokens({ inputTokens: totals.input, outputTokens: totals.output, billableInputTokens: totals.input })} (${totals.input} input + ${totals.output} output${totalExtras.length > 0 ? ` | ${totalExtras.join(', ')}` : ''})`
    )
    lines.push('')
  }
}

export function sessionToMarkdown(session: Session): string {
  const lines: string[] = []
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 }
  const visibleMessageCount = session.messages.filter((message) => message.role !== 'system').length

  appendSessionHeader(lines, session, visibleMessageCount)
  for (const msg of session.messages) {
    appendMessageMarkdown(lines, msg, totals)
  }
  appendTokenTotals(lines, totals)

  return lines.join('\n')
}

export async function exportSessionMarkdownFromDb(session: Session): Promise<string> {
  const lines: string[] = []
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 }
  const totalMessages =
    session.messageCount ??
    (await invokeMessagePackBinary<number>(DB_MESSAGES_COUNT_MSGPACK_CHANNEL, session.id))

  appendSessionHeader(lines, session, totalMessages)

  for (let offset = 0; offset < totalMessages; offset += EXPORT_MESSAGE_PAGE_SIZE) {
    const rows = await invokeMessagePackBinary<MessageRow[]>(
      DB_MESSAGES_LIST_PAGE_MSGPACK_CHANNEL,
      {
        sessionId: session.id,
        limit: EXPORT_MESSAGE_PAGE_SIZE,
        offset
      }
    )
    if (rows.length === 0) break
    for (const row of rows) {
      appendMessageMarkdown(lines, rowToMessage(row), totals)
    }
  }

  appendTokenTotals(lines, totals)
  return lines.join('\n')
}

export async function exportSessionSnapshotFromDb(session: Session): Promise<Session> {
  const totalMessages =
    session.messageCount ??
    (await invokeMessagePackBinary<number>(DB_MESSAGES_COUNT_MSGPACK_CHANNEL, session.id))
  const messages: UnifiedMessage[] = []

  for (let offset = 0; offset < totalMessages; offset += EXPORT_MESSAGE_PAGE_SIZE) {
    const rows = await invokeMessagePackBinary<MessageRow[]>(
      DB_MESSAGES_LIST_PAGE_MSGPACK_CHANNEL,
      {
        sessionId: session.id,
        limit: EXPORT_MESSAGE_PAGE_SIZE,
        offset
      }
    )
    if (rows.length === 0) break
    messages.push(...rows.map(rowToMessage))
  }

  return {
    ...session,
    messages,
    messageCount: totalMessages,
    messagesLoaded: true,
    loadedRangeStart: 0,
    loadedRangeEnd: totalMessages,
    lastKnownMessageCount: totalMessages,
    promptSnapshot: undefined
  }
}
