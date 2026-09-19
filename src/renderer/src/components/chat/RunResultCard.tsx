import * as React from 'react'
import { Check, CircleAlert, Copy, FileOutput, GitFork, Loader2, ScanSearch, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import type { ChatRunPresentation } from './chat-run-view-model'

interface RunResultCardProps {
  presentation: ChatRunPresentation | null
  onViewProcess: () => void
  onCopyResult?: () => void
  onReviewChanges?: () => void
  onExportResult?: () => void
  onFork?: () => void
}

function durationLabel(durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null
  if (durationMs < 1000) return `${durationMs}ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`
}

export function RunResultCard({
  presentation,
  onViewProcess,
  onCopyResult,
  onReviewChanges,
  onExportResult,
  onFork
}: RunResultCardProps): React.JSX.Element | null {
  const { t } = useTranslation('chat')

  if (!presentation) return null

  const statusLabel =
    presentation.status === 'running'
      ? t('runResult.running')
      : presentation.status === 'failed'
        ? t('runResult.failed')
        : presentation.status === 'pending-approval'
          ? t('runResult.needsAttention')
          : presentation.status === 'canceled'
            ? t('runResult.canceled')
            : t('runResult.completed')
  const StatusIcon =
    presentation.status === 'running'
      ? Loader2
      : presentation.status === 'failed' || presentation.status === 'canceled'
        ? X
        : presentation.status === 'pending-approval'
          ? CircleAlert
          : Check
  const duration = durationLabel(presentation.durationMs)
  return (
    <section
      className={cn(
        'mt-2 border-b border-border/60 text-xs',
        presentation.status === 'failed' && 'border-destructive/30',
        presentation.status === 'pending-approval' && 'border-amber-500/30'
      )}
      aria-label={t('runResult.title')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 py-2">
        <StatusIcon
          className={cn(
            'size-3.5 shrink-0',
            presentation.status === 'running' && 'animate-spin text-sky-500',
            presentation.status === 'completed' && 'text-emerald-500',
            presentation.status === 'failed' && 'text-destructive',
            presentation.status === 'pending-approval' && 'text-amber-500',
            presentation.status === 'canceled' && 'text-muted-foreground'
          )}
          aria-hidden="true"
        />
        <span className="font-medium text-foreground">{statusLabel}</span>
        {presentation.stepCount > 0 ? (
          <span className="text-muted-foreground">
            {t('runResult.steps', { count: presentation.stepCount })}
          </span>
        ) : null}
        {duration ? <span className="text-muted-foreground">{duration}</span> : null}
        {presentation.changeSummary.fileCount > 0 ? (
          <span className="font-medium text-foreground/80">
            {t('runResult.filesChanged', { count: presentation.changeSummary.fileCount })}
            <span className="ml-1 text-emerald-600 dark:text-emerald-300">
              +{presentation.changeSummary.added}
            </span>
            <span className="ml-1 text-red-600 dark:text-red-300">
              -{presentation.changeSummary.deleted}
            </span>
          </span>
        ) : null}
        {presentation.attentionCount > 0 ? (
          <span className="font-medium text-amber-600 dark:text-amber-400">
            {t('runResult.attention', { count: presentation.attentionCount })}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="rounded-md px-1.5 py-1 font-medium text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
            onClick={onViewProcess}
          >
            {t('runResult.viewProcess')}
          </button>
          {onReviewChanges && presentation.changeSummary.fileCount > 0 ? (
            <button
              type="button"
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
              onClick={onReviewChanges}
              title={t('runResult.reviewChanges')}
            >
              <ScanSearch className="size-3.5" />
              <span className="text-[11px] font-medium">{t('runResult.reviewChanges')}</span>
            </button>
          ) : null}
          {onExportResult ? (
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
              onClick={onExportResult}
              title={t('runResult.exportResult')}
              aria-label={t('runResult.exportResult')}
            >
              <FileOutput className="size-3.5" />
            </button>
          ) : null}
          {onFork ? (
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
              onClick={onFork}
              title={t('runResult.fork')}
              aria-label={t('runResult.fork')}
            >
              <GitFork className="size-3.5" />
            </button>
          ) : null}
          {onCopyResult ? (
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
              onClick={onCopyResult}
              title={t('runResult.copyResult')}
              aria-label={t('runResult.copyResult')}
            >
              <Copy className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>
    </section>
  )
}
