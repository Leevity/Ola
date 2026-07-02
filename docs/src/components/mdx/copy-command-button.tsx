'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

export function CopyCommandButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  async function onCopy() {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <button
      type="button"
      aria-label={copied ? 'Command copied' : 'Copy command'}
      title={copied ? 'Copied' : 'Copy command'}
      onClick={onCopy}
      className="absolute right-2 top-2 inline-grid size-7 place-items-center rounded-md border border-fd-border bg-fd-muted/70 text-fd-muted-foreground transition hover:border-cowork-red/50 hover:text-fd-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cowork-red/70"
    >
      {copied ? <Check className="size-3.5 text-cowork-red" /> : <Copy className="size-3.5" />}
    </button>
  )
}
