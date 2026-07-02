import * as React from 'react'
import { Check, ImageDown, Eye, Code2, ZoomIn } from 'lucide-react'
import mermaid from 'mermaid'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import {
  applyMermaidTheme,
  copyMermaidToClipboard,
  useMermaidThemeVersion
} from '@renderer/lib/utils/mermaid-theme'

export function MermaidBlock({ code }: { code: string }): React.JSX.Element {
  const [svg, setSvg] = React.useState('')
  const [error, setError] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [mode, setMode] = React.useState<'preview' | 'code'>('preview')
  const [zoomOpen, setZoomOpen] = React.useState(false)
  const renderId = React.useId().replace(/:/g, '-')
  const themeVersion = useMermaidThemeVersion()

  const handleCopyImage = React.useCallback(async () => {
    if (!code.trim()) return
    setBusy(true)
    try {
      await copyMermaidToClipboard(code, svg)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('[Mermaid] Copy image failed:', err)
    } finally {
      setBusy(false)
    }
  }, [code, svg])

  React.useEffect(() => {
    let cancelled = false

    async function renderDiagram(): Promise<void> {
      const source = code.trim()
      if (!source) {
        setSvg('')
        setError('')
        return
      }

      try {
        applyMermaidTheme()
        const result = await mermaid.render(`mermaid-${renderId}-${Date.now()}`, source)
        if (cancelled) return
        setSvg(result.svg)
        setError('')
      } catch (err) {
        if (cancelled) return
        setSvg('')
        setError(err instanceof Error ? err.message : 'Failed to render Mermaid diagram.')
      }
    }

    void renderDiagram()
    return () => {
      cancelled = true
    }
  }, [code, renderId, themeVersion])

  return (
    <div className="my-3 overflow-hidden rounded-md border border-border/60 bg-background">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-3 py-1.5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">
          mermaid
        </span>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center rounded-md border p-0.5">
            <Button
              variant={mode === 'preview' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-5 gap-1 px-2 text-[10px]"
              onClick={() => setMode('preview')}
            >
              <Eye className="size-3" /> Preview
            </Button>
            <Button
              variant={mode === 'code' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-5 gap-1 px-2 text-[10px]"
              onClick={() => setMode('code')}
            >
              <Code2 className="size-3" /> Code
            </Button>
          </div>
          {mode === 'preview' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 gap-1 px-2 text-[10px]"
                onClick={() => setZoomOpen(true)}
                disabled={!svg.trim()}
                title="Zoom in Mermaid diagram"
              >
                <ZoomIn className="size-3" />
                <span>Zoom in</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 gap-1 px-2 text-[10px]"
                onClick={() => void handleCopyImage()}
                disabled={busy || !svg.trim()}
                title="Copy Mermaid diagram to clipboard"
              >
                {copied ? <Check className="size-3" /> : <ImageDown className="size-3" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="p-3">
        {mode === 'code' ? (
          <pre className="overflow-x-auto rounded-md bg-muted/60 p-3 text-xs">
            <code>{code}</code>
          </pre>
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-xs font-medium text-destructive/90">Mermaid render failed</p>
            <p className="mt-1 text-xs text-destructive/70">{error}</p>
            <pre className="mt-2 overflow-x-auto rounded bg-background/70 p-2 text-xs">{code}</pre>
          </div>
        ) : !svg ? (
          <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
            Rendering Mermaid diagram...
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md bg-background">
            <div
              className="[&_svg]:mx-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        )}
      </div>
      <Dialog open={zoomOpen} onOpenChange={setZoomOpen}>
        <DialogContent className="flex h-[90vh] w-[95vw] max-w-[95vw] flex-col p-4">
          <DialogTitle className="sr-only">Mermaid Zoom Preview</DialogTitle>
          <div className="flex-1 overflow-auto rounded-md bg-background p-4">
            {svg ? (
              <div
                className="flex min-h-full min-w-max items-start justify-center [&_svg]:h-auto [&_svg]:max-w-none"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
