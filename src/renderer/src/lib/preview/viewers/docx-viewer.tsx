import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import DOMPurify from 'dompurify'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { openMarkdownHref } from './markdown-components'
import type { ViewerProps } from '../viewer-registry'

async function convertDocxToHtml(base64: string): Promise<string> {
  const mammoth = await import('mammoth')
  const buffer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer.buffer })
  return DOMPurify.sanitize(result.value, {
    ALLOWED_TAGS: [
      'a',
      'b',
      'blockquote',
      'br',
      'code',
      'div',
      'em',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'i',
      'li',
      'ol',
      'p',
      'pre',
      'span',
      'strong',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'u',
      'ul'
    ],
    ALLOWED_ATTR: ['colspan', 'href', 'rowspan', 'title'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|#)/i,
    FORBID_TAGS: ['base', 'form', 'iframe', 'img', 'style', 'svg'],
    FORBID_ATTR: ['style']
  })
}

export function DocxViewer({
  filePath,
  sshConnectionId,
  fileVersion
}: ViewerProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [html, setHtml] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const channel = sshConnectionId ? IPC.SSH_FS_READ_FILE_BINARY : IPC.FS_READ_FILE_BINARY
    const args = sshConnectionId
      ? { connectionId: sshConnectionId, path: filePath }
      : { path: filePath }
    ipcClient.invoke(channel, args).then(async (raw: unknown) => {
      if (cancelled) return
      const result = raw as { data?: string; error?: string }
      if (result.error || !result.data) {
        setError(result.error || 'Failed to read file')
        setLoading(false)
        return
      }
      try {
        const converted = await convertDocxToHtml(result.data)
        if (!cancelled) setHtml(converted)
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [filePath, fileVersion, sshConnectionId])

  if (loading) {
    return (
      <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <FileText className="size-5 animate-pulse" />
        Loading document...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex size-full items-center justify-center text-sm text-destructive">
        {error}
      </div>
    )
  }

  return (
    <div className="size-full overflow-y-auto p-6">
      <div className="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {t('preview.docxCompatibilityHint')}
      </div>
      <div
        className="prose prose-sm dark:prose-invert max-w-none"
        onClick={(event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          const link = target.closest('a[href]')
          if (!(link instanceof HTMLAnchorElement)) return
          const url = new URL(link.href, window.location.href)
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            event.preventDefault()
            openMarkdownHref(url.href)
          }
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
