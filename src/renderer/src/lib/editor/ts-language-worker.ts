import ts from 'typescript'
import type {
  TsLanguageCompletion,
  TsLanguageDiagnostic,
  TsLanguageRequest,
  TsLanguageResponse
} from './ts-language-protocol'

// The compiler reads its default libraries through the host, and a worker has no
// filesystem, so every lib.d.ts ships inside this bundle. The relative path is
// the repository root seen from src/renderer/src/lib/editor.
const libModules = import.meta.glob('../../../../../node_modules/typescript/lib/lib.*.d.ts', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

const LIB_DIRECTORY = '/libs'
const libFiles = new Map<string, string>()
for (const [path, content] of Object.entries(libModules)) {
  libFiles.set(`${LIB_DIRECTORY}/${path.split('/').pop()}`, content)
}

const RENDERER_GLOBALS_PATH = `${LIB_DIRECTORY}/ola-renderer-globals.d.ts`
const RENDERER_GLOBALS = `
declare interface OlaDesktopApi {
  platform: string
  versions: { electron: string; chrome: string; node: string }
  getPathForFile: (file: File) => string
}

declare global {
  interface Window {
    ola: { desktop: OlaDesktopApi }
  }
}

export {}
`
libFiles.set(RENDERER_GLOBALS_PATH, RENDERER_GLOBALS)

// The renderer cannot resolve workspace imports, so reporting these three codes
// would bury every file in noise.
const IGNORED_CODES = new Set([2307, 2792, 7016])
const MAX_COMPLETIONS = 300

const compilerOptions: ts.CompilerOptions = {
  allowJs: true,
  allowNonTsExtensions: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  target: ts.ScriptTarget.ES2022,
  noEmit: true,
  types: []
}

const documents = new Map<string, { content: string; version: number }>()

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (fileName.endsWith('.js')) return ts.ScriptKind.JS
  if (fileName.endsWith('.json')) return ts.ScriptKind.JSON
  return ts.ScriptKind.TS
}

const host: ts.LanguageServiceHost = {
  getCompilationSettings: () => compilerOptions,
  getScriptFileNames: () => [...documents.keys(), ...libFiles.keys(), RENDERER_GLOBALS_PATH],
  getScriptVersion: (fileName) => String(documents.get(fileName)?.version ?? 0),
  getScriptSnapshot: (fileName) => {
    const content = documents.get(fileName)?.content ?? libFiles.get(fileName)
    return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content)
  },
  getScriptKind: scriptKind,
  getCurrentDirectory: () => '/',
  getDefaultLibFileName: () => `${LIB_DIRECTORY}/lib.es2022.full.d.ts`,
  useCaseSensitiveFileNames: () => true,
  getNewLine: () => '\n',
  fileExists: (fileName) => documents.has(fileName) || libFiles.has(fileName),
  readFile: (fileName) => documents.get(fileName)?.content ?? libFiles.get(fileName),
  directoryExists: () => false,
  getDirectories: () => []
}

const service = ts.createLanguageService(host)

function severity(category: ts.DiagnosticCategory): TsLanguageDiagnostic['severity'] {
  if (category === ts.DiagnosticCategory.Error) return 'error'
  if (category === ts.DiagnosticCategory.Warning) return 'warning'
  return 'info'
}

function collectDiagnostics(path: string): TsLanguageDiagnostic[] {
  const raw = [
    ...service.getSyntacticDiagnostics(path),
    ...service.getSemanticDiagnostics(path),
    ...service.getSuggestionDiagnostics(path)
  ]
  const result: TsLanguageDiagnostic[] = []
  for (const item of raw) {
    if (item.start === undefined || item.length === undefined) continue
    if (IGNORED_CODES.has(item.code)) continue
    result.push({
      start: item.start,
      length: item.length,
      message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
      severity: severity(item.category),
      code: item.code
    })
  }
  return result
}

function plainInsertText(entry: ts.CompletionEntry): string {
  const text = entry.insertText ?? entry.name
  // TypeScript emits snippet placeholders (${1:arg}); CodeMirror inserts the apply
  // string literally, so keep the placeholder default and drop the markers.
  return text
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\{\d+\}/g, '')
    .replace(/\$0/g, '')
}

function collectCompletions(path: string, offset: number): TsLanguageCompletion[] {
  const info = service.getCompletionsAtPosition(path, offset, {
    includeCompletionsForModuleExports: false,
    includeCompletionsWithInsertText: true
  })
  if (!info) return []
  return info.entries.slice(0, MAX_COMPLETIONS).map((entry) => ({
    label: entry.name,
    kind: entry.kind,
    detail: entry.kindModifiers ?? '',
    insertText: plainInsertText(entry),
    sortText: entry.sortText
  }))
}

function collectHover(path: string, offset: number) {
  const info = service.getQuickInfoAtPosition(path, offset)
  if (!info) return null
  return {
    display: ts.displayPartsToString(info.displayParts),
    documentation: ts.displayPartsToString(info.documentation)
  }
}

function handle(request: TsLanguageRequest): TsLanguageResponse {
  switch (request.type) {
    case 'open':
    case 'change': {
      const previous = documents.get(request.path)
      documents.set(request.path, {
        content: request.content,
        version: (previous?.version ?? 0) + 1
      })
      return { id: request.id, type: 'ack' }
    }
    case 'close':
      documents.delete(request.path)
      return { id: request.id, type: 'ack' }
    case 'diagnostics':
      return { id: request.id, type: 'diagnostics', diagnostics: collectDiagnostics(request.path) }
    case 'completions':
      return {
        id: request.id,
        type: 'completions',
        completions: collectCompletions(request.path, request.offset)
      }
    case 'hover':
      return { id: request.id, type: 'hover', hover: collectHover(request.path, request.offset) }
  }
}

const scope = self as unknown as {
  postMessage: (message: TsLanguageResponse) => void
  onmessage: ((event: MessageEvent<TsLanguageRequest>) => void) | null
}

scope.onmessage = (event) => {
  const request = event.data
  try {
    scope.postMessage(handle(request))
  } catch (error) {
    scope.postMessage({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}
