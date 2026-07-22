import * as React from 'react'
import { Braces, CheckCircle2, CircleAlert } from 'lucide-react'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'

export function CodeGraphToolCard({ output }: { output: string }): React.JSX.Element | null {
  const result = React.useMemo(() => decodeStructuredToolResult(output), [output])
  if (!result || Array.isArray(result)) return null

  const success = result.success !== false
  const text = typeof result.text === 'string' ? result.text : ''
  const notices = Array.isArray(result.notices)
    ? result.notices.filter((notice): notice is string => typeof notice === 'string')
    : []

  return (
    <div
      className="overflow-hidden rounded-lg border border-border/60 bg-muted/10"
      data-codegraph-card
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-xs">
        <Braces className="size-3.5 text-violet-500" />
        <span className="font-medium">CodeGraph</span>
        {success ? (
          <CheckCircle2 className="ml-auto size-3.5 text-emerald-500" />
        ) : (
          <CircleAlert className="ml-auto size-3.5 text-destructive" />
        )}
      </div>
      {text ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 text-[11px] leading-5 text-foreground/80">
          {text}
        </pre>
      ) : null}
      {notices.length > 0 ? (
        <div className="border-t border-border/50 px-3 py-2 text-[10px] text-muted-foreground">
          {notices.join(' · ')}
        </div>
      ) : null}
    </div>
  )
}
