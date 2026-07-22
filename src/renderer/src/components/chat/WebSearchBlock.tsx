import * as React from 'react'
import { ExternalLink, Globe2 } from 'lucide-react'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { openMarkdownHref } from '@renderer/lib/preview/viewers/markdown-components'

interface SearchResult {
  title: string
  url: string
  content?: string
  publishedDate?: string
}

function parseResults(output: string): SearchResult[] {
  const value = decodeStructuredToolResult(output)
  if (!value || Array.isArray(value) || !Array.isArray(value.results)) return []
  return value.results.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const result = item as Record<string, unknown>
    if (typeof result.url !== 'string') return []
    return [
      {
        title: typeof result.title === 'string' ? result.title : result.url,
        url: result.url,
        content: typeof result.content === 'string' ? result.content : undefined,
        publishedDate: typeof result.publishedDate === 'string' ? result.publishedDate : undefined
      }
    ]
  })
}

export function WebSearchBlock({ output }: { output: string }): React.JSX.Element | null {
  const results = React.useMemo(() => parseResults(output), [output])
  if (results.length === 0) return null

  return (
    <div className="space-y-2" data-web-search-results>
      {results.map((result) => (
        <button
          key={result.url}
          type="button"
          className="group flex w-full gap-2.5 rounded-lg border border-border/55 bg-muted/15 p-2.5 text-left transition-colors hover:bg-muted/35"
          onClick={() => openMarkdownHref(result.url)}
        >
          <Globe2 className="mt-0.5 size-3.5 shrink-0 text-sky-500" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 text-xs font-medium text-foreground/90">
              <span className="truncate">{result.title}</span>
              <ExternalLink className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-70" />
            </span>
            {result.content ? (
              <span className="mt-1 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">
                {result.content}
              </span>
            ) : null}
            <span className="mt-1 block truncate text-[10px] text-muted-foreground/60">
              {result.publishedDate ? `${result.publishedDate} · ` : ''}
              {result.url}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
