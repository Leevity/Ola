import { autocompletion, type Completion, type CompletionContext } from '@codemirror/autocomplete'
import { linter, type Diagnostic } from '@codemirror/lint'
import { hoverTooltip, type EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import TsLanguageWorker from './ts-language-worker?worker'
import type { TsLanguageRequestInput, TsLanguageResponse } from './ts-language-protocol'

let worker: Worker | null = null
let nextRequestId = 1
let sessionCount = 0
const pending = new Map<number, (response: TsLanguageResponse) => void>()

function sharedWorker(): Worker | null {
  if (worker) return worker
  try {
    const created = new TsLanguageWorker()
    created.onmessage = (event: MessageEvent<TsLanguageResponse>) => {
      const resolve = pending.get(event.data.id)
      if (!resolve) return
      pending.delete(event.data.id)
      resolve(event.data)
    }
    worker = created
  } catch (error) {
    console.warn('[Editor] TypeScript language worker unavailable', error)
    return null
  }
  return worker
}

function request(message: TsLanguageRequestInput): Promise<TsLanguageResponse | null> {
  const target = sharedWorker()
  if (!target) return Promise.resolve(null)
  const id = nextRequestId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    target.postMessage({ ...message, id })
  })
}

const COMPLETION_TYPES: Record<string, string> = {
  method: 'method',
  function: 'function',
  property: 'property',
  class: 'class',
  interface: 'interface',
  enum: 'enum',
  keyword: 'keyword',
  module: 'namespace',
  type: 'type',
  var: 'variable',
  let: 'variable',
  const: 'variable',
  parameter: 'variable'
}

function toCompletion(entry: {
  label: string
  kind: string
  detail: string
  insertText: string
  sortText: string
}): Completion {
  return {
    label: entry.label,
    type: COMPLETION_TYPES[entry.kind] ?? 'text',
    detail: entry.detail,
    apply: entry.insertText
  }
}

function hoverDom(display: string, documentation: string): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'ola-editor-hover'
  const signature = document.createElement('pre')
  signature.textContent = display
  dom.appendChild(signature)
  if (documentation) {
    const description = document.createElement('div')
    description.textContent = documentation
    dom.appendChild(description)
  }
  return dom
}

export interface TsLanguageSession {
  extensions: Extension[]
  update: (content: string) => void
  dispose: () => void
}

/**
 * One shared worker serves every open editor, so each session owns a distinct
 * document path. Only the extension matters to the compiler; the prefix keeps two
 * editors showing the same file from overwriting each other's content.
 */
export function createTsLanguageSession(modelPath: string): TsLanguageSession {
  sessionCount += 1
  // The compiler looks documents up as file paths. A model URI keeps its scheme
  // and its empty authority segment (`inmemory://ola/…`, `file:///…`), and neither
  // survives the program's path normalization, so both are stripped here.
  const path = `/session-${sessionCount}/${modelPath
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')}`
  let latest = ''
  let disposed = false

  const sync = (content: string): void => {
    if (disposed || content === latest) return
    latest = content
    void request({ type: 'change', path, content })
  }

  const lintExtension = linter(
    async (view: EditorView) => {
      if (disposed) return []
      const content = view.state.doc.toString()
      sync(content)
      const response = await request({ type: 'diagnostics', path })
      if (disposed || response?.type !== 'diagnostics') return []
      const length = view.state.doc.length
      const diagnostics: Diagnostic[] = []
      for (const item of response.diagnostics) {
        const from = Math.max(0, Math.min(item.start, length))
        diagnostics.push({
          from,
          to: Math.max(from, Math.min(item.start + item.length, length)),
          severity: item.severity,
          message: item.message
        })
      }
      return diagnostics
    },
    { delay: 400 }
  )

  const completionExtension = autocompletion({
    override: [
      async (context: CompletionContext) => {
        if (disposed) return null
        sync(context.state.doc.toString())
        const response = await request({
          type: 'completions',
          path,
          offset: context.pos
        })
        if (disposed || response?.type !== 'completions') return null
        const word = context.matchBefore(/[\w$]*/)
        const from = word ? word.from : context.pos
        return {
          from,
          options: response.completions.map((entry, index) => ({
            ...toCompletion(entry),
            boost: response.completions.length - index
          })),
          validFor: /^[\w$]*$/
        }
      }
    ]
  })

  const hoverExtension = hoverTooltip(async (view: EditorView, pos: number) => {
    if (disposed) return null
    sync(view.state.doc.toString())
    const response = await request({ type: 'hover', path, offset: pos })
    if (disposed || response?.type !== 'hover' || !response.hover) return null
    const { display, documentation } = response.hover
    if (!display && !documentation) return null
    return {
      pos,
      end: pos,
      above: true,
      create: () => ({ dom: hoverDom(display, documentation) })
    }
  })

  void request({ type: 'open', path, content: '' })

  return {
    extensions: [lintExtension, completionExtension, hoverExtension],
    update: sync,
    dispose: () => {
      if (disposed) return
      disposed = true
      void request({ type: 'close', path })
    }
  }
}
