import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2 } from 'lucide-react'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import { useLiveCompressionStore } from '@renderer/stores/live-compression-store'

/**
 * Inline status card rendered in place of a synthetic system message whose
 * `meta.compressionStatus` is set. Two visual modes:
 *  - `compressing` — animated loader while the summarizer is running.
 *  - `compressed`  — green check + count of summarized messages once it succeeds.
 *
 * The actual compactBoundary / compactSummary cards still render separately at
 * the in-history compression point; this card sits at the moment compression
 * happened and acts as a UX confirmation that the run paused, summarized, and
 * resumed without touching prior turns.
 */
export function CompressionStatusMessage({
  message
}: {
  message: UnifiedMessage
}): React.JSX.Element | null {
  const { t } = useTranslation('agent')
  const status = message.meta?.compressionStatus
  if (!status) return null

  const tokenFormatter = new Intl.NumberFormat()

  if (status.state === 'compressing') {
    return (
      <div className="my-2 flex items-center gap-2 rounded-md border border-border bg-muted/25 px-3 py-2 text-[12px]">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-400" />
        <span className="font-medium text-foreground">
          {t('contextCompression.compressing', { defaultValue: 'Compressing context…' })}
        </span>
      </div>
    )
  }

  return (
    <div className="my-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted/25 px-3 py-2 text-[12px]">
      <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <span className="font-medium text-foreground">
        {t('contextCompression.compressed', { defaultValue: 'Context compressed' })}
      </span>
      {typeof status.keptMessageCount === 'number' && status.keptMessageCount > 0 ? (
        <span className="text-[11px] text-muted-foreground">
          {t('contextCompression.compressedDetail', {
            defaultValue: '{{count}} messages compressed',
            count: status.keptMessageCount
          })}
        </span>
      ) : null}
      {typeof status.preTokens === 'number' && status.preTokens > 0 ? (
        <span className="text-[11px] text-muted-foreground">
          {t('contextCompression.boundaryPreTokens', {
            defaultValue: '{{tokens}} tokens at trigger',
            tokens: tokenFormatter.format(status.preTokens)
          })}
        </span>
      ) : null}
    </div>
  )
}

export function LiveCompressionStatus({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation('agent')
  const entry = useLiveCompressionStore((state) => state.bySessionId[sessionId])
  if (!entry || entry.state !== 'compressing') return null

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 w-[min(520px,calc(100%-2rem))] -translate-x-1/2">
      <div className="rounded-md border border-amber-500/30 bg-background/95 px-3 py-2 text-[12px] shadow-lg backdrop-blur">
        <div className="flex items-center gap-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-400" />
          <span className="font-medium text-foreground">
            {t('contextCompression.compressing', { defaultValue: 'Compressing context…' })}
          </span>
        </div>
        {entry.draft ? (
          <p className="mt-1.5 max-h-20 overflow-hidden whitespace-pre-wrap text-[11px] text-muted-foreground">
            {entry.draft}
          </p>
        ) : null}
      </div>
    </div>
  )
}
