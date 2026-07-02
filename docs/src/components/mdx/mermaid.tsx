'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'

type RenderState = {
  bindFunctions?: (element: Element) => void
  error?: string
  loading: boolean
  svg?: string
}

const cache = new Map<string, Promise<unknown>>()

function cachePromise<T>(key: string, setPromise: () => Promise<T>): Promise<T> {
  const cached = cache.get(key)
  if (cached) return cached as Promise<T>

  const promise = setPromise()
  cache.set(key, promise)
  return promise
}

export function Mermaid({ chart }: { chart: string }) {
  const id = useId()
  const { resolvedTheme } = useTheme()
  const [state, setState] = useState<RenderState>({ loading: true })
  const diagramId = useMemo(() => `mermaid-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`, [id])

  useEffect(() => {
    let cancelled = false

    async function renderDiagram() {
      setState({ loading: true })

      try {
        const { default: mermaid } = await cachePromise('mermaid', () => import('mermaid'))
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          fontFamily: 'inherit',
          themeCSS: 'margin: 1.5rem auto 0;',
          theme: resolvedTheme === 'light' ? 'default' : 'dark'
        })

        const { svg, bindFunctions } = await mermaid.render(
          diagramId,
          chart.replaceAll('\\n', '\n')
        )

        if (!cancelled) {
          setState({ bindFunctions, loading: false, svg })
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            error: error instanceof Error ? error.message : String(error),
            loading: false
          })
        }
      }
    }

    void renderDiagram()

    return () => {
      cancelled = true
    }
  }, [chart, diagramId, resolvedTheme])

  if (state.loading) {
    return (
      <div className="not-prose my-6 rounded-lg border border-fd-border bg-fd-card/50 p-4 text-sm text-fd-muted-foreground">
        Rendering diagram...
      </div>
    )
  }

  if (state.error) {
    return (
      <div className="not-prose my-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100">
        <div className="font-semibold">Diagram parse error</div>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-amber-100/80">
          {state.error}
        </pre>
      </div>
    )
  }

  return (
    <div
      className="mermaid-frame not-prose my-6 overflow-x-auto rounded-lg border border-fd-border bg-fd-card/45 p-4"
      ref={(container) => {
        if (container) state.bindFunctions?.(container)
      }}
      dangerouslySetInnerHTML={{ __html: state.svg ?? '' }}
    />
  )
}
