import { useMemo, useState } from 'react'
import { Archive, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import {
  getCompactSummaryDisplayText,
  isCompactBoundaryMessage,
  isCompactSummaryLikeMessage
} from '@renderer/lib/agent/context-compression'
import { navigateToConversationTarget } from '@renderer/lib/conversation-navigation-events'
import { cn } from '@renderer/lib/utils'

interface ContextTimelineItem {
  id: string
  messageId: string
  trigger: 'auto' | 'manual' | null
  messagesSummarized: number | null
  preTokens: number | null
  preview: string
}

function truncatePreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 120).trim()}…` : normalized
}

export function ContextTimeline({
  sessionId,
  messages
}: {
  sessionId?: string | null
  messages: UnifiedMessage[]
}): React.JSX.Element | null {
  const { t } = useTranslation('cowork')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const items = useMemo<ContextTimelineItem[]>(() => {
    const result: ContextTimelineItem[] = []
    let latestBoundary: UnifiedMessage | null = null

    for (const message of messages) {
      if (isCompactBoundaryMessage(message)) {
        latestBoundary = message
        continue
      }
      if (!isCompactSummaryLikeMessage(message)) continue

      const boundary = latestBoundary
      const summaryMeta = message.meta?.compactSummary
      const boundaryMeta = boundary?.meta?.compactBoundary
      result.push({
        id: message.id,
        messageId: message.id,
        trigger: boundaryMeta?.trigger ?? null,
        messagesSummarized:
          summaryMeta?.messagesSummarized ?? boundaryMeta?.messagesSummarized ?? null,
        preTokens: boundaryMeta?.preTokens ?? null,
        preview: getCompactSummaryDisplayText(message)
      })
    }

    return result
  }, [messages])

  if (items.length === 0) return null

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {t('context.compressionTimeline.title')}
      </h4>
      <div className="space-y-1.5 border-l border-amber-500/25 pl-3">
        {items.map((item) => {
          const expanded = expandedId === item.id
          const detailParts = [
            item.trigger
              ? t(`context.compressionTimeline.${item.trigger}`)
              : t('context.compressionTimeline.compressed'),
            item.messagesSummarized !== null
              ? t('context.compressionTimeline.messages', { count: item.messagesSummarized })
              : null,
            item.preTokens !== null
              ? t('context.compressionTimeline.preTokens', { count: item.preTokens })
              : null
          ].filter((value): value is string => Boolean(value))

          return (
            <div key={item.id} className="relative">
              <span className="absolute -left-[17px] top-2 size-2 rounded-full bg-amber-500/80 ring-4 ring-background" />
              <div className="group rounded-md border border-border/50 bg-muted/20 transition-colors hover:bg-muted/45">
                <div className="flex min-w-0 items-center gap-1.5 px-2.5 pt-2">
                  <Archive className="size-3 shrink-0 text-amber-500" />
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-foreground/85"
                    onClick={() =>
                      navigateToConversationTarget({
                        sessionId,
                        messageId: item.messageId
                      })
                    }
                  >
                    {t('context.compressionTimeline.compressed')}
                  </button>
                  <button
                    type="button"
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
                    aria-expanded={expanded}
                    aria-label={t('context.compressionTimeline.toggle')}
                    onClick={() =>
                      setExpandedId((current) => (current === item.id ? null : item.id))
                    }
                  >
                    <ChevronDown
                      className={cn('size-3 transition-transform', expanded && 'rotate-180')}
                    />
                  </button>
                </div>
                <button
                  type="button"
                  className="block w-full px-2.5 pb-2 pt-1 text-left"
                  onClick={() =>
                    navigateToConversationTarget({
                      sessionId,
                      messageId: item.messageId
                    })
                  }
                >
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {detailParts.join(' · ')}
                  </span>
                  <span
                    className={cn(
                      'mt-1.5 block text-[11px] leading-4 text-muted-foreground',
                      !expanded && 'line-clamp-2'
                    )}
                  >
                    {expanded ? item.preview : truncatePreview(item.preview)}
                  </span>
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
