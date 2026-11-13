import * as React from 'react'
import { PlainTextCode, type SyntaxHighlighterProps } from './PlainTextCode'

// The grammars are ~230 KB across 32 languages. Importing them here would defeat
// the name, so they live in prism-highlighter.tsx behind this boundary.
const PrismHighlighter = React.lazy(() => import('./prism-highlighter'))

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  sh: 'bash',
  shell: 'bash',
  cs: 'csharp',
  yml: 'yaml',
  md: 'markdown',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  text: 'plaintext'
}

function normalizeLanguage(language?: string): string {
  if (!language) return 'plaintext'
  const normalized = language.toLowerCase().trim()
  return LANGUAGE_ALIASES[normalized] ?? normalized
}

export function LazySyntaxHighlighter(props: SyntaxHighlighterProps): React.JSX.Element {
  const { language, showLineNumbers } = props
  const normalizedLanguage = normalizeLanguage(language)
  // Prism markdown wraps fenced code blocks as multi-line tokens, which collides with line numbers.
  const forcePlainText = normalizedLanguage === 'markdown' && showLineNumbers === true

  if (forcePlainText || normalizedLanguage === 'plaintext') {
    return <PlainTextCode {...props} />
  }

  return (
    <React.Suspense fallback={<PlainTextCode {...props} />}>
      <PrismHighlighter {...props} language={normalizedLanguage} />
    </React.Suspense>
  )
}
