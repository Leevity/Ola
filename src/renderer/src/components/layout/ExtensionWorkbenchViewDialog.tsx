import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useUIStore } from '@renderer/stores/ui-store'

const VIEW_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"

export function ExtensionWorkbenchViewDialog(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const target = useUIStore((state) => state.extensionWorkbenchView)
  const close = useUIStore((state) => state.closeExtensionWorkbenchView)
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setHtml(null)
    setError(null)
    if (!target) return
    let cancelled = false
    void ipcClient
      .invoke(IPC.EXTENSION_READ_ASSET, { id: target.extensionId, path: target.view.entry })
      .then((result) => {
        const response = result as { content?: unknown; error?: unknown }
        if (cancelled) return
        if (typeof response.content !== 'string') {
          setError(
            t('extensionView.loadFailed', {
              defaultValue:
                'Could not load this extension view. Check that the extension is enabled and its view file is available.'
            })
          )
          return
        }
        setHtml(
          `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}"></head><body>${response.content}</body></html>`
        )
      })
      .catch(() => {
        if (cancelled) return
        setError(
          t('extensionView.loadFailed', {
            defaultValue:
              'Could not load this extension view. Check that the extension is enabled and its view file is available.'
          })
        )
      })
    return () => {
      cancelled = true
    }
  }, [target, t])

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex h-[min(82vh,900px)] w-[min(92vw,1200px)] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-3 text-left">
          <DialogTitle>{target?.view.title ?? ''}</DialogTitle>
          <DialogDescription>
            {target?.view.description ?? target?.extensionName ?? ''}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 bg-background">
          {html ? (
            <iframe
              title={
                target?.view.title ?? t('extensionView.title', { defaultValue: 'Extension view' })
              }
              srcDoc={html}
              sandbox=""
              referrerPolicy="no-referrer"
              className="size-full border-0"
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
              {error ?? t('extensionView.loading', { defaultValue: 'Loading view…' })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
