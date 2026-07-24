import Markdown from 'react-markdown'
import { Archive, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import type { ContextCompressionPreview } from '@renderer/hooks/use-chat-actions'
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '@renderer/lib/preview/viewers/markdown-components'

interface ContextCompressionPreviewDialogProps {
  open: boolean
  preview: ContextCompressionPreview | null
  loading?: boolean
  applying?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function ContextCompressionPreviewDialog({
  open,
  preview,
  loading = false,
  applying = false,
  onOpenChange,
  onConfirm
}: ContextCompressionPreviewDialogProps): React.JSX.Element {
  const { t } = useTranslation('agent')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" showCloseButton={!loading && !applying}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="size-4" />
            {t('contextCompression.previewDialogTitle')}
          </DialogTitle>
          <DialogDescription>{t('contextCompression.previewDialogDescription')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('contextCompression.previewGenerating')}
          </div>
        ) : preview ? (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded border border-border/70 bg-muted/35 px-2 py-1">
                {t('contextCompression.summaryMessages', { count: preview.messagesSummarized })}
              </span>
              <span>{t('contextCompression.previewPlacement')}</span>
            </div>
            <div className="max-h-[50vh] overflow-y-auto rounded-md border border-border/70 bg-muted/20 p-4 prose prose-sm max-w-none dark:prose-invert [&_h1]:mt-0 [&_h2]:mt-4 [&_p]:my-2">
              <Markdown
                remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
              >
                {preview.summary}
              </Markdown>
            </div>
          </>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading || applying}
          >
            {t('contextCompression.previewCancel')}
          </Button>
          <Button onClick={onConfirm} disabled={!preview || loading || applying}>
            {applying ? <Loader2 className="animate-spin" /> : null}
            {t('contextCompression.previewConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
