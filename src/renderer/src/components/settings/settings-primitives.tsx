import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'

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
        <h2 className="text-sm font-semibold text-foreground/90">{title}</h2>
        {description ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  )
}
