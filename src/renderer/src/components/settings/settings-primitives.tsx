import type { ReactNode } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

export const SETTINGS_PANEL_CLASS = 'w-full space-y-6'
export const SETTINGS_CARD_CLASS = 'rounded-xl border border-border/60 bg-muted/10 p-4'

export function SettingsPageHeader({
  title,
  titleId,
  description,
  icon: Icon,
  className
}: {
  title: string
  titleId?: string
  description?: string
  icon?: React.ComponentType<{ className?: string }>
  className?: string
}): React.JSX.Element {
  return (
    <header className={cn('flex items-start gap-3', className)}>
      {Icon ? <Icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" /> : null}
      <div className="min-w-0">
        <h2 id={titleId} className="text-xl font-semibold text-foreground">
          {title}
        </h2>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
    </header>
  )
}

export function SettingsSectionCard({
  title,
  description,
  children,
  className,
  action,
  icon: Icon
}: {
  title: string
  description?: string
  children: ReactNode
  className?: string
  action?: ReactNode
  icon?: React.ComponentType<{ className?: string }>
}): React.JSX.Element {
  return (
    <section className={cn(SETTINGS_CARD_CLASS, className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {Icon ? (
            <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          ) : null}
          <div className="min-w-0">
            <h3 className="text-[0.9375rem] font-semibold text-foreground/90">{title}</h3>
            {description ? (
              <p className="mt-1 text-[0.8125rem] leading-5 text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

export function SettingsField({
  label,
  description,
  children,
  className
}: {
  label: string
  description?: string
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-4', className)}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground/90">{label}</p>
        {description ? (
          <p className="mt-1 text-[0.8125rem] leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SettingsEmptyState({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

export function SettingsSafetyNotice({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[0.8125rem] leading-5 text-muted-foreground">
      <AlertTriangle
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <p>{children}</p>
    </div>
  )
}

export function SettingsInfoNotice({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-2 rounded-lg border border-border/60 bg-muted/10 p-3 text-[0.8125rem] leading-5 text-muted-foreground">
      <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      <p>{children}</p>
    </div>
  )
}

export function SettingsPanelSection({
  title,
  description,
  children,
  className
}: {
  title: string
  description?: string
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={cn('space-y-4', className)}>
      <div>
        <h3 className="text-[0.9375rem] font-semibold text-foreground/90">{title}</h3>
        {description ? (
          <p className="mt-1 text-[0.8125rem] leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  )
}
