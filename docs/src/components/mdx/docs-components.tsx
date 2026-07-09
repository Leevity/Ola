import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  ClipboardList,
  Info,
  Terminal,
  TriangleAlert
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopyCommandButton } from '@/components/mdx/copy-command-button'

export function DocCards({ children }: { children: ReactNode }) {
  return <div className="not-prose my-6 grid gap-3 sm:grid-cols-2">{children}</div>
}

export function DocCard({
  title,
  description,
  href,
  eyebrow
}: {
  title: string
  description: string
  href: string
  eyebrow?: string
}) {
  const isExternal = href.startsWith('http')
  const className =
    'group relative flex min-h-30 flex-col justify-between overflow-hidden rounded-lg border border-fd-border/80 bg-fd-card/70 p-4 text-left transition duration-150 hover:-translate-y-0.5 hover:border-cowork-red/60 hover:bg-cowork-red/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cowork-red/70'
  const content = (
    <>
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cowork-red/70 to-transparent opacity-0 transition group-hover:opacity-100" />
      <span>
        {eyebrow ? (
          <span className="mb-2 block font-mono text-[11px] uppercase text-cowork-red">
            {eyebrow}
          </span>
        ) : null}
        <span className="text-sm font-semibold text-fd-foreground">{title}</span>
      </span>
      <span className="mt-2 text-sm leading-6 text-fd-muted-foreground">{description}</span>
      <span className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-cowork-red">
        Open <ArrowRight className="size-3 transition group-hover:translate-x-0.5" />
      </span>
    </>
  )

  if (isExternal) {
    return (
      <a className={className} href={href} target="_blank" rel="noreferrer">
        {content}
      </a>
    )
  }

  return (
    <Link className={className} href={href}>
      {content}
    </Link>
  )
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="not-prose my-6 grid gap-3">{children}</ol>
}

export function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="rounded-lg border border-fd-border/70 bg-fd-muted/30 p-4 transition hover:border-cowork-red/35 hover:bg-cowork-red/5">
      <div className="flex items-center gap-2 text-sm font-semibold text-fd-foreground">
        <CheckCircle2 className="size-4 text-cowork-red" />
        {title}
      </div>
      <div className="mt-2 text-sm leading-6 text-fd-muted-foreground">{children}</div>
    </li>
  )
}

export function Callout({
  type = 'info',
  title,
  children
}: {
  type?: 'info' | 'warn'
  title: string
  children: ReactNode
}) {
  const isWarn = type === 'warn'

  return (
    <div
      className={cn(
        'not-prose my-6 rounded-lg border p-4 text-sm leading-6',
        isWarn
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
          : 'border-cowork-red/30 bg-cowork-red/10 text-fd-foreground'
      )}
    >
      <div className="mb-1 flex items-center gap-2 font-semibold">
        {isWarn ? <TriangleAlert className="size-4" /> : <Info className="size-4" />}
        {title}
      </div>
      <div className="text-fd-muted-foreground">{children}</div>
    </div>
  )
}

export function CommandGroup({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border border-fd-border bg-black/65 terminal-panel">
      <div className="flex items-start justify-between gap-4 border-b border-fd-border/80 bg-white/[0.025] px-4 py-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-fd-foreground">
            <Terminal className="size-4 text-cowork-red" />
            {title}
          </div>
          {description ? (
            <div className="mt-1 text-xs leading-5 text-fd-muted-foreground">{description}</div>
          ) : null}
        </div>
        <span className="rounded border border-fd-border bg-fd-muted px-2 py-1 font-mono text-[11px] text-fd-muted-foreground">
          shell
        </span>
      </div>
      <div className="divide-y divide-fd-border/70">{children}</div>
    </div>
  )
}

export function CommandItem({
  command,
  label,
  note
}: {
  command: string
  label?: string
  note?: string
}) {
  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[160px_1fr] sm:items-start">
      <div className="text-xs font-medium text-fd-muted-foreground">{label}</div>
      <div className="min-w-0">
        <div className="relative">
          <code className="block overflow-x-auto rounded-md border border-fd-border/70 bg-[#080707] px-3 py-2 pe-12 font-mono text-xs leading-6 text-fd-foreground">
            <span className="select-none text-cowork-red">$ </span>
            {command}
          </code>
          <CopyCommandButton value={command} />
        </div>
        {note ? <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{note}</p> : null}
      </div>
    </div>
  )
}

export function SignalGrid({ children }: { children: ReactNode }) {
  return <div className="not-prose my-6 grid gap-3 md:grid-cols-3">{children}</div>
}

export function Signal({
  title,
  value,
  children
}: {
  title: string
  value: string
  children: ReactNode
}) {
  return (
    <div className="rounded-lg border border-fd-border/80 bg-fd-card/60 p-4">
      <div className="flex items-center gap-2 font-mono text-[11px] uppercase text-cowork-red">
        <CircleDot className="size-3" />
        {title}
      </div>
      <div className="mt-3 text-sm font-semibold text-fd-foreground">{value}</div>
      <div className="mt-2 text-sm leading-6 text-fd-muted-foreground">{children}</div>
    </div>
  )
}

export function Runbook({ children }: { children: ReactNode }) {
  return <ol className="runbook-list not-prose my-6 grid gap-3">{children}</ol>
}

export function RunbookStep({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="runbook-step relative rounded-lg border border-fd-border/80 bg-fd-card/55 p-4 ps-14">
      <div className="flex items-center gap-2 text-sm font-semibold text-fd-foreground">
        <ClipboardList className="size-4 text-cowork-red" />
        {title}
      </div>
      <div className="mt-2 text-sm leading-6 text-fd-muted-foreground">{children}</div>
    </li>
  )
}
