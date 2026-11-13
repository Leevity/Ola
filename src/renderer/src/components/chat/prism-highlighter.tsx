import * as React from 'react'
import { useTheme } from 'next-themes'
import PrismLight from 'react-syntax-highlighter/dist/esm/prism-light'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import prismBash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import prismC from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import prismCpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import prismCsharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp'
import prismCss from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import prismDart from 'react-syntax-highlighter/dist/esm/languages/prism/dart'
import prismDocker from 'react-syntax-highlighter/dist/esm/languages/prism/docker'
import prismGo from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import prismGraphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql'
import prismIni from 'react-syntax-highlighter/dist/esm/languages/prism/ini'
import prismJava from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import prismJavascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import prismJson from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import prismJsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import prismKotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin'
import prismLess from 'react-syntax-highlighter/dist/esm/languages/prism/less'
import prismLua from 'react-syntax-highlighter/dist/esm/languages/prism/lua'
import prismMakefile from 'react-syntax-highlighter/dist/esm/languages/prism/makefile'
import prismMarkdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import prismMarkup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import prismPhp from 'react-syntax-highlighter/dist/esm/languages/prism/php'
import prismPython from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import prismR from 'react-syntax-highlighter/dist/esm/languages/prism/r'
import prismRuby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import prismRust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import prismScss from 'react-syntax-highlighter/dist/esm/languages/prism/scss'
import prismSql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import prismSwift from 'react-syntax-highlighter/dist/esm/languages/prism/swift'
import prismToml from 'react-syntax-highlighter/dist/esm/languages/prism/toml'
import prismTsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import prismTypescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import prismYaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import { PlainTextCode, type SyntaxHighlighterProps } from './PlainTextCode'

type SyntaxHighlighterComponent = React.ComponentType<Record<string, unknown>> & {
  registerLanguage?: (name: string, grammar: unknown) => void
}

const LANGUAGE_GRAMMARS: Record<string, unknown> = {
  typescript: prismTypescript,
  javascript: prismJavascript,
  python: prismPython,
  bash: prismBash,
  json: prismJson,
  css: prismCss,
  scss: prismScss,
  less: prismLess,
  jsx: prismJsx,
  tsx: prismTsx,
  markdown: prismMarkdown,
  yaml: prismYaml,
  rust: prismRust,
  go: prismGo,
  sql: prismSql,
  graphql: prismGraphql,
  c: prismC,
  csharp: prismCsharp,
  cpp: prismCpp,
  java: prismJava,
  kotlin: prismKotlin,
  ruby: prismRuby,
  php: prismPhp,
  swift: prismSwift,
  docker: prismDocker,
  makefile: prismMakefile,
  r: prismR,
  lua: prismLua,
  dart: prismDart,
  toml: prismToml,
  ini: prismIni,
  markup: prismMarkup
}

const Highlighter = PrismLight as unknown as SyntaxHighlighterComponent

for (const [language, grammar] of Object.entries(LANGUAGE_GRAMMARS)) {
  Highlighter.registerLanguage?.(language, grammar)
}

export default function PrismHighlighter({
  language,
  children,
  className,
  customStyle,
  codeTagProps,
  showLineNumbers,
  startingLineNumber,
  lineNumberStyle,
  lineProps,
  wrapLongLines,
  ...rest
}: SyntaxHighlighterProps): React.JSX.Element {
  const { resolvedTheme } = useTheme()

  if (!language || !Object.hasOwn(LANGUAGE_GRAMMARS, language)) {
    return (
      <PlainTextCode
        language={language}
        className={className}
        customStyle={customStyle}
        codeTagProps={codeTagProps}
        showLineNumbers={showLineNumbers}
        startingLineNumber={startingLineNumber}
        lineNumberStyle={lineNumberStyle}
        lineProps={lineProps}
        wrapLongLines={wrapLongLines}
      >
        {children}
      </PlainTextCode>
    )
  }

  return (
    <Highlighter
      language={language}
      style={resolvedTheme === 'light' ? oneLight : oneDark}
      className={className}
      customStyle={customStyle}
      codeTagProps={codeTagProps}
      showLineNumbers={showLineNumbers}
      startingLineNumber={startingLineNumber}
      lineNumberStyle={lineNumberStyle}
      lineProps={lineProps}
      wrapLongLines={wrapLongLines}
      {...rest}
    >
      {children}
    </Highlighter>
  )
}
