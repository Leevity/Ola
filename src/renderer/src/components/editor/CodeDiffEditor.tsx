import * as React from 'react'
import {
  getOriginalDoc,
  MergeView,
  originalDocChangeEffect,
  unifiedMergeView
} from '@codemirror/merge'
import { ChangeSet, Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { FileWarning } from 'lucide-react'
import { useTheme } from 'next-themes'
import { loadEditorLanguage } from '@renderer/lib/editor/codemirror-language'
import { baseEditorExtensions } from '@renderer/lib/editor/codemirror-setup'
import { editorTheme } from '@renderer/lib/editor/codemirror-theme'
import { guessLanguage } from '@renderer/lib/editor/languages'
import {
  createTsLanguageSession,
  type TsLanguageSession
} from '@renderer/lib/editor/ts-language-service'

export interface CodeDiffEditorProps {
  filePath: string
  original: string
  modified: string
  language?: string
  /** When true the modified (right) side is editable. Original is always read-only. */
  modifiedEditable?: boolean
  /** Split (side-by-side) vs inline (unified) rendering. */
  renderSideBySide?: boolean
  isBinary?: boolean
  height?: string | number
  onModifiedChange?: (value: string) => void
  onSave?: () => void | Promise<void>
}

// Guard rails: diffing past these sizes locks up the renderer, so we show a
// placeholder instead.
const MAX_DIFF_BYTES = 2_000_000
const MAX_DIFF_LINES = 50_000

function countLines(text: string): number {
  let lines = 1
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1
  }
  return lines
}

function DiffPlaceholder({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground">
      <FileWarning className="size-5 text-amber-500" />
      <span>{message}</span>
    </div>
  )
}

export function CodeDiffEditor({
  filePath,
  original,
  modified,
  language,
  modifiedEditable = false,
  renderSideBySide = true,
  isBinary = false,
  height = '100%',
  onModifiedChange,
  onSave
}: CodeDiffEditorProps): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme !== 'light'

  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const mergeRef = React.useRef<MergeView | null>(null)
  const unifiedRef = React.useRef<EditorView | null>(null)
  const sessionRef = React.useRef<TsLanguageSession | null>(null)
  const themeSlot = React.useRef(new Compartment()).current
  const languageSlot = React.useRef(new Compartment()).current
  const servicesSlot = React.useRef(new Compartment()).current

  const latest = React.useRef({ original, modified, onModifiedChange, onSave, dark })
  React.useEffect(() => {
    latest.current = { original, modified, onModifiedChange, onSave, dark }
  })

  const tooLarge =
    original.length + modified.length > MAX_DIFF_BYTES ||
    countLines(original) + countLines(modified) > MAX_DIFF_LINES

  const languageId = language ?? guessLanguage(filePath)

  const modifiedViews = React.useCallback((): EditorView[] => {
    if (mergeRef.current) return [mergeRef.current.a, mergeRef.current.b]
    if (unifiedRef.current) return [unifiedRef.current]
    return []
  }, [])

  // The layout decides which CM6 construct is used (a two-editor MergeView or a
  // single editor with a unified decoration), so switching it rebuilds the view.
  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const shared = [
      baseEditorExtensions(),
      themeSlot.of(editorTheme(latest.current.dark)),
      languageSlot.of([])
    ]
    const modifiedExtensions = [
      ...shared,
      EditorState.readOnly.of(!modifiedEditable),
      EditorView.editable.of(modifiedEditable),
      servicesSlot.of([]),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            void latest.current.onSave?.()
            return true
          }
        }
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) latest.current.onModifiedChange?.(update.state.doc.toString())
      })
    ]

    if (renderSideBySide) {
      const merge = new MergeView({
        parent: host,
        orientation: 'a-b',
        highlightChanges: true,
        gutter: true,
        a: {
          doc: latest.current.original,
          extensions: [...shared, EditorState.readOnly.of(true), EditorView.editable.of(false)]
        },
        b: { doc: latest.current.modified, extensions: modifiedExtensions }
      })
      // The merge view scrolls as one unit so both sides stay line-aligned; the
      // package only gives it overflow, not a height.
      merge.dom.style.height = '100%'
      mergeRef.current = merge
      return () => {
        mergeRef.current = null
        merge.destroy()
      }
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: latest.current.modified,
        extensions: [
          ...modifiedExtensions,
          unifiedMergeView({
            original: latest.current.original,
            highlightChanges: true,
            gutter: true,
            mergeControls: false
          })
        ]
      })
    })
    unifiedRef.current = view
    return () => {
      unifiedRef.current = null
      view.destroy()
    }
  }, [
    isBinary,
    languageSlot,
    modifiedEditable,
    renderSideBySide,
    servicesSlot,
    themeSlot,
    tooLarge
  ])

  React.useEffect(() => {
    const view = mergeRef.current?.b ?? unifiedRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === modified) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: modified } })
  }, [modified, renderSideBySide, modifiedEditable, isBinary, tooLarge])

  React.useEffect(() => {
    if (mergeRef.current) {
      const view = mergeRef.current.a
      const current = view.state.doc.toString()
      if (current === original) return
      view.dispatch({ changes: { from: 0, to: current.length, insert: original } })
      return
    }
    const view = unifiedRef.current
    if (!view) return
    const currentDoc = getOriginalDoc(view.state)
    const current = currentDoc.toString()
    if (current === original) return
    view.dispatch({
      effects: originalDocChangeEffect(
        view.state,
        ChangeSet.of({ from: 0, to: current.length, insert: original }, current.length)
      )
    })
  }, [original, renderSideBySide, modifiedEditable, isBinary, tooLarge])

  React.useEffect(() => {
    for (const view of modifiedViews()) {
      view.dispatch({ effects: themeSlot.reconfigure(editorTheme(dark)) })
    }
  }, [dark, modifiedViews, themeSlot])

  React.useEffect(() => {
    let cancelled = false
    void loadEditorLanguage(languageId).then((extension) => {
      if (cancelled) return
      for (const view of modifiedViews()) {
        view.dispatch({ effects: languageSlot.reconfigure(extension ?? []) })
      }
    })
    return () => {
      cancelled = true
    }
  }, [languageId, languageSlot, modifiedViews])

  React.useEffect(() => {
    const view = mergeRef.current?.b ?? unifiedRef.current
    if (!view) return
    if (languageId !== 'typescript' && languageId !== 'javascript') {
      view.dispatch({ effects: servicesSlot.reconfigure([]) })
      return
    }
    const session = createTsLanguageSession(`diff/${filePath}`)
    sessionRef.current = session
    session.update(view.state.doc.toString())
    view.dispatch({ effects: servicesSlot.reconfigure(session.extensions) })
    return () => {
      session.dispose()
      if (sessionRef.current === session) sessionRef.current = null
    }
  }, [filePath, languageId, servicesSlot, renderSideBySide, modifiedEditable, isBinary, tooLarge])

  if (isBinary) {
    return <DiffPlaceholder message="Binary file — cannot show a diff." />
  }
  if (tooLarge) {
    return <DiffPlaceholder message="File is too large to diff in the editor." />
  }

  return <div className="size-full overflow-hidden" ref={hostRef} style={{ height }} />
}
