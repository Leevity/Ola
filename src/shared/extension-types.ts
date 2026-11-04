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

export type ExtensionCapabilityKind =
  | 'network.request' // 联网（legacy permissions.network）
  | 'filesystem.read' // 读工作区/任意路径
  | 'filesystem.write' // 写文件
  | 'process' // 跑命令
  | 'secret.read' // 读宿主密钥
  | 'agent.tool' // 注册 agent 工具
  | 'agent.context' // 向上下文注入
  | 'clipboard'
  | 'window.notify'

export interface ExtensionCapabilityDeclaration {
  /** 装上就要批的能力（审查看到的上界 = required ∪ optional）。 */
  required: ExtensionCapabilityKind[]
  /** 运行期可申请的能力。 */
  optional?: ExtensionCapabilityKind[]
}

export interface ExtensionPermissions {
  /** Legacy flat network host whitelist. Projected to capabilities at parse time; not rewritten on disk. */
  network?: string[]
  /** Declared capability upper bound. */
  capabilities?: ExtensionCapabilityDeclaration
  /** Per-URL network scope whitelist. */
  hostPermissions?: string[]
  /** Prefix globs for workspace paths: `docs/*`, `src/**`. */
  pathScopes?: string[]
}

export interface ExtensionManifest {
  schemaVersion: 1
  id: string
  name: string
  version: string
  description?: string
  entry?: string
  configSchema?: ExtensionConfigFieldSchema[]
  permissions?: ExtensionPermissions
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
