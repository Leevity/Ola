import * as React from 'react'
import { autocompletion } from '@codemirror/autocomplete'
import { redo, undo } from '@codemirror/commands'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { useTheme } from 'next-themes'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { loadEditorLanguage } from '@renderer/lib/editor/codemirror-language'
import { baseEditorExtensions } from '@renderer/lib/editor/codemirror-setup'
import { editorTheme } from '@renderer/lib/editor/codemirror-theme'
import { guessLanguage } from '@renderer/lib/editor/languages'
import {
  findImportPathAtPosition,
  resolveImportTarget
} from '@renderer/lib/editor/source-navigation'
import {
  createTsLanguageSession,
  type TsLanguageSession
} from '@renderer/lib/editor/ts-language-service'
import { createModelUri, type EditorWorkspace } from '@renderer/lib/editor/workspace'

export interface CodeEditorProps {
  filePath: string
  content: string
  height?: string | number
  language?: string
  workspace?: EditorWorkspace | null
  onChange?: (value: string) => void
  onSave?: () => void | Promise<void>
  onOpenFile?: (filePath: string) => void | Promise<void>
  initialLine?: number
  initialColumn?: number
  initialPositionKey?: number
}

export interface CodeEditorHandle {
  undo: () => void
  redo: () => void
  focus: () => void
}

export const CodeEditor = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  {
    filePath,
    content,
    height = '100%',
    language,
    workspace,
    onChange,
    onSave,
    onOpenFile,
    initialLine,
    initialColumn,
    initialPositionKey
  },
  ref
): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme !== 'light'
  const editorWorkspaceEnabled = useSettingsStore((s) => s.editorWorkspaceEnabled)
  const editorRemoteLanguageServiceEnabled = useSettingsStore(
    (s) => s.editorRemoteLanguageServiceEnabled
  )

  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const viewRef = React.useRef<EditorView | null>(null)
  const sessionRef = React.useRef<TsLanguageSession | null>(null)
  const languageSlot = React.useRef(new Compartment()).current
  const themeSlot = React.useRef(new Compartment()).current
  const languageServicesSlot = React.useRef(new Compartment()).current

  const latest = React.useRef({ onChange, onSave, onOpenFile, filePath, workspace, content, dark })
  React.useEffect(() => {
    latest.current = { onChange, onSave, onOpenFile, filePath, workspace, content, dark }
  })

  const openImportAt = React.useCallback(async (view: EditorView, pos: number) => {
    const {
      onOpenFile: openFile,
      filePath: currentPath,
      workspace: currentWorkspace
    } = latest.current
    if (!openFile) return
    const line = view.state.doc.lineAt(pos)
    const match = findImportPathAtPosition(line.text, pos - line.from + 1)
    if (!match) return
    const target = await resolveImportTarget({
      currentFilePath: currentPath,
      specifier: match.specifier,
      workspace: currentWorkspace
    })
    if (!target) return
    await openFile(target)
  }, [])

  const openImportAtCursor = React.useCallback(() => {
    const view = viewRef.current
    if (!view) return
    void openImportAt(view, view.state.selection.main.head)
  }, [openImportAt])

  // The view is created once and every changing input is applied through a
  // compartment, so remounting never loses undo history or cursor position.
  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: latest.current.content,
        extensions: [
          baseEditorExtensions(),
          themeSlot.of(editorTheme(latest.current.dark)),
          languageSlot.of([]),
          languageServicesSlot.of(autocompletion()),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                void latest.current.onSave?.()
                return true
              }
            },
            {
              key: 'F12',
              run: () => {
                openImportAtCursor()
                return true
              }
            }
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange?.(update.state.doc.toString())
          }),
          EditorView.domEventHandlers({
            mousedown: (event, view) => {
              if (!(event.ctrlKey || event.metaKey)) return false
              if (!latest.current.onOpenFile) return false
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
              if (pos === null) return false
              view.dispatch({ selection: { anchor: pos } })
              void openImportAt(view, pos)
              return true
            }
          })
        ]
      })
    })
    viewRef.current = view
    return () => {
      sessionRef.current?.dispose()
      sessionRef.current = null
      viewRef.current = null
      view.destroy()
    }
  }, [])

  React.useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === content) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: content } })
  }, [content])

  const languageId = language ?? guessLanguage(filePath)

  React.useEffect(() => {
    let cancelled = false
    void loadEditorLanguage(languageId).then((extension) => {
      if (cancelled) return
      viewRef.current?.dispatch({ effects: languageSlot.reconfigure(extension ?? []) })
    })
    return () => {
      cancelled = true
    }
  }, [languageId, languageSlot])

  React.useEffect(() => {
    viewRef.current?.dispatch({ effects: themeSlot.reconfigure(editorTheme(dark)) })
  }, [dark, themeSlot])

  const modelPath = React.useMemo(
    () =>
      createModelUri({
        filePath,
        workspace,
        workspaceEnabled: editorWorkspaceEnabled,
        remoteLanguageServiceEnabled: editorRemoteLanguageServiceEnabled
      }),
    [editorRemoteLanguageServiceEnabled, editorWorkspaceEnabled, filePath, workspace]
  )

  React.useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (languageId !== 'typescript' && languageId !== 'javascript') {
      view.dispatch({ effects: languageServicesSlot.reconfigure(autocompletion()) })
      return
    }
    const session = createTsLanguageSession(modelPath)
    sessionRef.current = session
    session.update(view.state.doc.toString())
    view.dispatch({ effects: languageServicesSlot.reconfigure(session.extensions) })
    return () => {
      session.dispose()
      if (sessionRef.current === session) sessionRef.current = null
    }
  }, [languageId, languageServicesSlot, modelPath])

  React.useEffect(() => {
    const view = viewRef.current
    if (!view || !initialLine || initialLine < 1) return
    const doc = view.state.doc
    const lineNumber = Math.min(Math.max(1, Math.floor(initialLine)), doc.lines)
    const line = doc.line(lineNumber)
    const column = Math.min(Math.max(1, Math.floor(initialColumn ?? 1)), line.length + 1)
    const pos = line.from + column - 1
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' })
    })
    view.focus()
  }, [initialColumn, initialLine, initialPositionKey, modelPath])

  React.useImperativeHandle(
    ref,
    () => ({
      undo: () => {
        const view = viewRef.current
        if (!view) return
        view.focus()
        undo(view)
      },
      redo: () => {
        const view = viewRef.current
        if (!view) return
        view.focus()
        redo(view)
      },
      focus: () => {
        viewRef.current?.focus()
      }
    }),
    []
  )

  return <div className="size-full overflow-hidden" ref={hostRef} style={{ height }} />
})

CodeEditor.displayName = 'CodeEditor'
