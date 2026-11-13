export interface TsLanguageDiagnostic {
  start: number
  length: number
  message: string
  severity: 'error' | 'warning' | 'info'
  code: number
}

export interface TsLanguageCompletion {
  label: string
  kind: string
  detail: string
  insertText: string
  sortText: string
}

export interface TsLanguageHover {
  display: string
  documentation: string
}

export type TsLanguageRequest =
  | { id: number; type: 'open'; path: string; content: string }
  | { id: number; type: 'change'; path: string; content: string }
  | { id: number; type: 'close'; path: string }
  | { id: number; type: 'diagnostics'; path: string }
  | { id: number; type: 'completions'; path: string; offset: number }
  | { id: number; type: 'hover'; path: string; offset: number }

export type TsLanguageResponse =
  | { id: number; type: 'diagnostics'; diagnostics: TsLanguageDiagnostic[] }
  | { id: number; type: 'completions'; completions: TsLanguageCompletion[] }
  | { id: number; type: 'hover'; hover: TsLanguageHover | null }
  | { id: number; type: 'ack' }
  | { id: number; type: 'error'; message: string }

// A plain Omit over a union keeps only the shared keys, which would erase the
// per-variant payload; distributing preserves each variant's own fields.
export type TsLanguageRequestInput = TsLanguageRequest extends infer Variant
  ? Variant extends TsLanguageRequest
    ? Omit<Variant, 'id'>
    : never
  : never
