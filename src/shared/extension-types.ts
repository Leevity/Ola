export type ExtensionToolKind = 'http' | 'js'
export type ExtensionUiKind = 'card' | 'table' | 'form' | 'chart' | 'html' | 'component'

export interface ExtensionConfigFieldSchema {
  key: string
  label: string
  type: 'text' | 'secret'
  required?: boolean
  description?: string
  placeholder?: string
  defaultValue?: string
}

export interface ExtensionHttpDefinition {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
}

export interface ExtensionToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  kind: ExtensionToolKind
  http?: ExtensionHttpDefinition
  handler?: string
  readOnly?: boolean
  /** Extract one verified HTTP(S) link from a JSON response into run artifacts. */
  artifact?: {
    kind: 'link'
    urlPointer: string
    titlePointer?: string
  }
}

export interface ExtensionFetchRequest {
  method?: string
  url: string
  headers?: Record<string, string>
  body?: unknown
}

export interface ExtensionFetchResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  text: string
  json?: unknown
}

export interface ExtensionRendererDefinition {
  name: string
  type: 'html'
  entry: string
}

export interface ExtensionComponentDefinition {
  name: string
  type: 'html'
  entry: string
  title?: string
  description?: string
}

export interface ExtensionWorkbenchViewDefinition {
  name: string
  title: string
  description?: string
  entry: string
}

export interface ExtensionWorkbenchCommandDefinition {
  name: string
  title: string
  description?: string
  keywords?: string[]
  view: string
}

export interface ExtensionManifest {
  schemaVersion: 1
  id: string
  name: string
  version: string
  description?: string
  entry?: string
  configSchema?: ExtensionConfigFieldSchema[]
  permissions?: {
    network?: string[]
  }
  tools: ExtensionToolDefinition[]
  renderers?: ExtensionRendererDefinition[]
  components?: ExtensionComponentDefinition[]
  views?: ExtensionWorkbenchViewDefinition[]
  commands?: ExtensionWorkbenchCommandDefinition[]
}

export interface ExtensionInstance {
  id: string
  enabled: boolean
  installedAt: number
  updatedAt: number
  config: Record<string, string>
  manifest: ExtensionManifest
}

export interface ExtensionToolResult {
  __olaExtensionResult: true
  extensionId: string
  toolName?: string
  text?: string
  data?: unknown
  ui?: {
    kind: ExtensionUiKind
    [key: string]: unknown
  }
  artifacts?: Array<{ kind: 'link'; url: string; title: string }>
}
