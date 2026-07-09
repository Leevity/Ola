import { Loader2, KeyRound } from 'lucide-react'

export type LoginProgressStep =
  | 'resolving'
  | 'navigating'
  | 'filling'
  | 'submitting'
  | 'detecting'
  | 'done'
  | 'paused'
  | 'failed'

const STEP_LABEL: Record<LoginProgressStep, string> = {
  resolving: 'Resolving credential…',
  navigating: 'Opening login page…',
  filling: 'Filling in credentials…',
  submitting: 'Submitting…',
  detecting: 'Inspecting the result…',
  done: 'Logged in',
  paused: 'Paused — manual action required',
  failed: 'Login failed'
}

interface Props {
  open: boolean
  step: LoginProgressStep
  domain: string | null
}

export function LoginProgressOverlay({ open, step, domain }: Props): React.JSX.Element | null {
  if (!open) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center">
      <div className="m-2 flex items-center gap-2 rounded-md border border-border/70 bg-background/95 px-3 py-1.5 text-[11px] shadow-md backdrop-blur">
        {step === 'paused' || step === 'failed' ? (
          <KeyRound className="size-3 text-amber-500" />
        ) : (
          <Loader2 className="size-3 animate-spin text-primary" />
        )}
        <span className="font-medium">{STEP_LABEL[step]}</span>
        {domain ? <span className="text-muted-foreground">· {domain}</span> : null}
      </div>
    </div>
  )
}
