import { StreamLanguage } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { simpleMode } from '@codemirror/legacy-modes/mode/simple-mode'

const graphqlMode = simpleMode({
  start: [
    { regex: /#.*/, token: 'comment' },
    { regex: /"""(?:[^"]|"(?!""))*"""/, token: 'string' },
    { regex: /"(?:[^"\\]|\\.)*"/, token: 'string' },
    {
      regex:
        /\b(?:query|mutation|subscription|fragment|on|type|interface|union|enum|input|schema|scalar|extend|implements|directive|repeatable)\b/,
      token: 'keyword'
    },
    { regex: /\b(?:true|false|null)\b/, token: 'atom' },
    { regex: /\$[A-Za-z_][A-Za-z0-9_]*/, token: 'variableName' },
    { regex: /@[A-Za-z_][A-Za-z0-9_]*/, token: 'meta' },
    { regex: /\b(?:Int|Float|String|Boolean|ID)\b/, token: 'typeName' },
    { regex: /-?\d+(?:\.\d+)?/, token: 'number' },
    { regex: /[{}()[\]:!=|&,]/, token: 'punctuation' }
  ]
})

const loaders: Record<string, () => Promise<Extension>> = {
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  typescript: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  scss: async () => (await import('@codemirror/lang-sass')).sass({ indented: false }),
  less: async () => (await import('@codemirror/lang-less')).less(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  c: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  ruby: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/ruby')).ruby),
  go: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/go')).go),
  csharp: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).csharp),
  shell: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
  powershell: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
  ini: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/properties')).properties),
  dockerfile: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
  graphql: async () => StreamLanguage.define(graphqlMode)
}

const loaded = new Map<string, Promise<Extension | null>>()

/** Languages are loaded on demand so previewing one file never pulls every parser. */
export function loadEditorLanguage(language: string): Promise<Extension | null> {
  const loader = loaders[language]
  if (!loader) return Promise.resolve(null)
  const cached = loaded.get(language)
  if (cached) return cached
  const promise = loader().catch((error) => {
    console.warn('[Editor] language support unavailable', language, error)
    return null
  })
  loaded.set(language, promise)
  return promise
}
