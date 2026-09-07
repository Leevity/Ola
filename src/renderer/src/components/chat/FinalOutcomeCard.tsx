import * as React from 'react'
import { AlertTriangle, Check, CircleX, File, MinusCircle, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FinalOutcome } from '@renderer/lib/api/types'
import { cn } from '@renderer/lib/utils'

interface FinalOutcomeCardProps {
  outcome: FinalOutcome
}

export function FinalOutcomeCard({ outcome }: FinalOutcomeCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const headingId = React.useId()
  const StatusIcon =
    outcome.status === 'completed'
      ? Check
      : outcome.status === 'partial'
        ? AlertTriangle
        : outcome.status === 'canceled'
          ? MinusCircle
          : CircleX

  return (
    <section
      className={cn(
        'rounded-xl border bg-background px-4 py-4 shadow-sm',
        outcome.status === 'completed' && 'border-emerald-500/25',
        outcome.status === 'partial' && 'border-amber-500/30',
        outcome.status === 'failed' && 'border-destructive/30',
        outcome.status === 'canceled' && 'border-border/70'
      )}
      aria-labelledby={headingId}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
            outcome.status === 'completed' &&
              'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
            outcome.status === 'partial' && 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
            outcome.status === 'failed' && 'bg-destructive/10 text-destructive',
            outcome.status === 'canceled' && 'bg-muted text-muted-foreground'
          )}
        >
          <StatusIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="text-sm font-semibold text-foreground">
            {outcome.title}
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-foreground/80">
            {outcome.summary}
          </p>
        </div>
      </div>

      {outcome.completedItems.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-xs font-medium text-foreground">{t('runOutcome.completedItems')}</h4>
          <ul className="mt-2 space-y-1.5 text-xs text-foreground/75">
            {outcome.completedItems.map((item, index) => (
              <li key={`${index}-${item}`} className="flex gap-2">
                <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
                <span className="break-words">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {outcome.artifacts.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-xs font-medium text-foreground">{t('runOutcome.artifacts')}</h4>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {outcome.artifacts.map((artifact) => (
              <span
                key={`${artifact.label}-${artifact.path ?? ''}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1 text-[11px] text-foreground/75"
                title={artifact.path}
              >
                <File className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{artifact.label}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {outcome.verification.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-xs font-medium text-foreground">{t('runOutcome.verification')}</h4>
          <ul className="mt-2 space-y-1.5 text-xs text-foreground/75">
            {outcome.verification.map((item) => (
              <li key={`${item.label}-${item.status}`} className="flex items-start gap-2">
                <ShieldCheck
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    item.status === 'passed'
                      ? 'text-emerald-500'
                      : item.status === 'failed'
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                  )}
                  aria-hidden="true"
                />
                <span>
                  {item.label}
                  {item.detail ? ` · ${item.detail}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {outcome.warnings.length > 0 ? (
        <div className="mt-4 rounded-lg bg-amber-500/8 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200">
          <div className="font-medium">{t('runOutcome.warnings')}</div>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            {outcome.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {outcome.nextSteps.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-xs font-medium text-foreground">{t('runOutcome.nextSteps')}</h4>
          <ul className="mt-2 list-decimal space-y-1 pl-4 text-xs text-foreground/75">
            {outcome.nextSteps.map((step, index) => (
              <li key={`${index}-${step}`}>{step}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {outcome.source === 'deterministic' ? (
        <p className="mt-3 text-[10px] text-muted-foreground">{t('runOutcome.systemSummary')}</p>
      ) : null}
    </section>
  )
}
