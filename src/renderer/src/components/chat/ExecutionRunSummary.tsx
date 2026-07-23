import * as React from 'react'
import { Check, ChevronDown, ChevronRight, CircleAlert, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import type { ToolExecutionRun } from './execution-outline'

interface ExecutionRunSummaryProps {
  run: ToolExecutionRun
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
  collapsedContent?: React.ReactNode
}

function durationLabel(durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null
  if (durationMs < 1000) return `${durationMs}ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`
}

function categorySummaries(
  run: ToolExecutionRun,
  t: (key: string, options?: Record<string, unknown>) => string
): string[] {
  const categories = run.categoryCounts
  const candidates: Array<[number, string]> = [
    [categories['file-change'] ?? 0, 'executionRun.fileChanges'],
    [categories.context ?? 0, 'executionRun.reviewedContext'],
    [categories.command ?? 0, 'executionRun.ranCommands'],
    [categories.mcp ?? 0, 'executionRun.externalTools'],
    [(categories.browser ?? 0) + (categories.desktop ?? 0), 'executionRun.browserActions'],
    [categories.orchestration ?? 0, 'executionRun.subTasks']
  ]
  const summaries = candidates
    .filter(([count]) => count > 0)
    .sort(([leftCount], [rightCount]) => rightCount - leftCount)
    .slice(0, 3)
    .map(([count, key]) => t(key, { count }))

  return summaries.length > 0
    ? summaries
    : [t('executionRun.completedSteps', { count: run.visibleItems.length })]
}

function completedSummary(
  run: ToolExecutionRun,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  return categorySummaries(run, t)[0]
}

export function ExecutionRunSummary({
  run,
  expanded,
  onToggle,
  children,
  collapsedContent
}: ExecutionRunSummaryProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const duration = durationLabel(run.durationMs)
  const statusLabel =
    run.status === 'running'
      ? t('executionRun.running')
      : run.status === 'failed'
        ? t('executionRun.failed')
        : run.status === 'canceled'
          ? t('executionRun.canceled')
          : run.status === 'pending-approval'
            ? t('executionRun.needsAttention')
            : completedSummary(run, t)
  const summary =
    run.status === 'completed'
      ? `${statusLabel}${duration ? ` · ${duration}` : ''}`
      : t('executionRun.summary', {
          count: run.visibleItems.length,
          status: statusLabel,
          duration: duration ? ` · ${duration}` : ''
        })
  const categoryTags = categorySummaries(run, t).slice(1)

  return (
    <section className="my-1.5" aria-label={t('executionRun.title')}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          'group flex w-full items-center gap-2 rounded-md border border-border/45 bg-muted/20 px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/40',
          run.status === 'failed' && 'border-destructive/30 bg-destructive/5',
          run.status === 'pending-approval' && 'border-amber-500/30 bg-amber-500/5'
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60">
          {run.status === 'running' ? (
            <Loader2 className="size-3 animate-spin text-sky-500" aria-hidden="true" />
          ) : run.status === 'failed' ? (
            <X className="size-3 text-destructive" aria-hidden="true" />
          ) : run.status === 'pending-approval' ? (
            <CircleAlert className="size-3 text-amber-500" aria-hidden="true" />
          ) : run.status === 'canceled' ? (
            <X className="size-3 text-muted-foreground" aria-hidden="true" />
          ) : (
            <Check className="size-3 text-emerald-500" aria-hidden="true" />
          )}
        </span>
        <span className="shrink-0 font-medium text-foreground/85">{t('executionRun.title')}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
        {run.status === 'failed' || run.status === 'pending-approval' ? (
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
              run.status === 'failed'
                ? 'bg-destructive/10 text-destructive'
                : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
            )}
          >
            {statusLabel}
          </span>
        ) : null}
        {categoryTags.length > 0 ? (
          <span className="hidden shrink-0 items-center gap-1 lg:flex" aria-label={summary}>
            {categoryTags.map((tag) => (
              <span
                key={tag}
                className="max-w-36 truncate rounded-full bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </span>
        ) : null}
        <span className="sr-only">
          {expanded ? t('executionRun.collapseDetails') : t('executionRun.expandDetails')}
        </span>
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
        )}
      </button>
      {expanded ? (
        <div className="ml-3 mt-1.5 border-l border-border/50 pl-4">{children}</div>
      ) : collapsedContent ? (
        <div className="mt-1.5">{collapsedContent}</div>
      ) : null}
    </section>
  )
}
