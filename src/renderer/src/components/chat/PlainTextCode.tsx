import * as React from 'react'

export type SyntaxHighlighterProps = Record<string, unknown> & {
  language?: string
  children: string
  className?: string
  customStyle?: React.CSSProperties
  codeTagProps?: React.HTMLAttributes<HTMLElement>
  showLineNumbers?: boolean
  startingLineNumber?: number
  lineNumberStyle?: React.CSSProperties
  lineProps?:
    | React.HTMLAttributes<HTMLSpanElement>
    | ((lineNumber: number) => React.HTMLAttributes<HTMLSpanElement>)
  wrapLongLines?: boolean
}

function resolveLineProps(
  lineProps: SyntaxHighlighterProps['lineProps'],
  lineNumber: number
): React.HTMLAttributes<HTMLSpanElement> {
  if (typeof lineProps === 'function') return lineProps(lineNumber) ?? {}
  return lineProps ?? {}
}

// Shared by the unknown-language path and the Suspense fallback, so code is readable
// immediately and does not reflow when the grammars arrive.
export function PlainTextCode({
  children,
  className,
  customStyle,
  codeTagProps,
  showLineNumbers,
  startingLineNumber,
  lineNumberStyle,
  lineProps,
  wrapLongLines
}: SyntaxHighlighterProps): React.JSX.Element {
  const shouldShowLineNumbers = showLineNumbers === true
  const firstLineNumber = typeof startingLineNumber === 'number' ? startingLineNumber : 1
  const lines = children.split('\n')
  const whiteSpace = wrapLongLines ? 'pre-wrap' : shouldShowLineNumbers ? 'pre' : 'pre-wrap'
  const wordBreak = wrapLongLines ? 'break-word' : shouldShowLineNumbers ? 'normal' : 'break-all'

  return (
    <pre
      className={className ?? 'text-xs'}
      style={{
        margin: 0,
        overflowX: 'auto',
        background: 'var(--muted)',
        color: 'var(--foreground)',
        whiteSpace,
        wordBreak,
        ...(customStyle ?? {})
      }}
    >
      <code
        {...codeTagProps}
        style={{
          display: 'block',
          minWidth: shouldShowLineNumbers && !wrapLongLines ? 'max-content' : undefined,
          fontFamily: 'inherit',
          fontSize: 'inherit',
          ...(codeTagProps?.style ?? {})
        }}
      >
        {shouldShowLineNumbers
          ? lines.map((line, index) => {
              const lineNumber = firstLineNumber + index
              const resolvedLineProps = resolveLineProps(lineProps, lineNumber)

              return (
                <span
                  key={index}
                  {...resolvedLineProps}
                  style={{
                    display: 'block',
                    whiteSpace,
                    ...(resolvedLineProps.style ?? {})
                  }}
                >
                  <span
                    className="react-syntax-highlighter-line-number"
                    style={{
                      display: 'inline-block',
                      minWidth: '1.25em',
                      paddingRight: '1em',
                      textAlign: 'right',
                      userSelect: 'none',
                      color: 'var(--muted-foreground)',
                      opacity: 0.72,
                      ...(lineNumberStyle ?? {})
                    }}
                  >
                    {lineNumber}
                  </span>
                  <span>{line}</span>
                </span>
              )
            })
          : children}
      </code>
    </pre>
  )
}
