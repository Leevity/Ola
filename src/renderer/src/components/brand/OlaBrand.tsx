import icon from '@renderer/assets/ola-brand-icon.png'
import { cn } from '@renderer/lib/utils'

export function OlaBrand({
  compact = false,
  className
}: {
  compact?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('inline-flex items-center gap-2.5', className)}>
      <img src={icon} alt={compact ? 'Ola' : ''} className="size-8 shrink-0 rounded-lg" />
      {!compact && <span className="text-xl font-semibold tracking-tight text-primary">ola</span>}
    </div>
  )
}
