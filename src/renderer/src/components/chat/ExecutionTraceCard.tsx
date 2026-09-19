import * as React from 'react'
import { Check, ChevronRight, CircleAlert, CircleX, MinusCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RunOutcomeMeta } from '@renderer/lib/api/types'
import { cn } from '@renderer/lib/utils'
import { formatDurationMs } from '@renderer/lib/format-duration'

interface ExecutionTraceCardProps {
  runOutcome: RunOutcomeMeta
  filesChanged?: number
  onViewProcess?: () => void
}

export function ExecutionTraceCard({
  runOutcome,
  filesChanged = 0,
  onViewProcess
}: ExecutionTraceCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const status = runOutcome.lifecycle
  const statusLabel = t(`runOutcome.status.${status}`)
  const StatusIcon =
    status === 'completed'
      ? Check
      : status === 'partial'
        ? CircleAlert
        : status === 'canceled'
          ? MinusCircle
          : CircleX

  return (
    <section className="mb-3 border-b border-border/60" aria-label={t('runOutcome.traceTitle')}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-1 py-2 text-left text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onViewProcess}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full',
            status === 'completed' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
            status === 'partial' && 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
            status === 'failed' && 'bg-destructive/10 text-destructive',
            status === 'canceled' && 'bg-muted text-muted-foreground'
          )}
        >
          <StatusIcon className="size-3" aria-hidden="true" />
        </span>
        <span className="font-medium text-foreground/90">{statusLabel}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {t('runOutcome.traceSummary', {
            steps: runOutcome.toolCallCount,
            files: filesChanged,
            duration: formatDurationMs(runOutcome.durationMs)
          })}
        </span>
        {runOutcome.failedToolCallCount > 0 ? (
          <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
            {t('runOutcome.failedSteps', { count: runOutcome.failedToolCallCount })}
          </span>
        ) : null}
        <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
      </button>
    </section>
  )
}
