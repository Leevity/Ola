// ── MCP Types for Renderer ──
// Re-exported / mirrored from main process types for use in renderer

/** Transport type for MCP server connections */
export type McpTransportType = 'stdio' | 'sse' | 'streamable-http'

/**
 * Pre-registered public OAuth client. When `clientId` is absent the authorization
 * server's dynamic registration endpoint is used. No secret ever reaches Renderer.
 */
export interface McpServerAuthConfig {
  clientId?: string
  scope?: string
}

/** MCP server configuration */
export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  /** Bound project ID (null = unbound) */
  projectId?: string | null
  transport: McpTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  /** OAuth for HTTP transports; tokens stay in Main. */
  auth?: McpServerAuthConfig
  autoFallback?: boolean
  createdAt: number
  description?: string
}

/**
 * MCP server runtime status. `authorization-required` means the server answered 401
 * and needs a browser authorization; it is not a connection failure.
 */
export type McpServerStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'authorization-required'
  | 'error'

/** MCP Tool */
export interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** MCP Resource */
export interface McpResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

/** MCP Prompt */
export interface McpPrompt {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

/** Full MCP server info */
export interface McpServerInfo {
  config: McpServerConfig
  status: McpServerStatus
  tools: McpTool[]
  resources: McpResource[]
  prompts: McpPrompt[]
  error?: string
}
