// ── MCP System — Shared Types ──

/** Transport type for MCP server connections */
export type McpTransportType = 'stdio' | 'sse' | 'streamable-http'

/**
 * Pre-registered OAuth client for an MCP server. When `clientId` is absent the
 * authorization server's registration endpoint is used instead. Only public
 * clients are supported: PKCE protects the flow and no secret is persisted here.
 */
export interface McpServerAuthConfig {
  clientId?: string
  scope?: string
}

/** MCP server configuration (persisted to mcp-servers.json) */
export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  /** Bound project ID (null = unbound) */
  projectId?: string | null

  // Transport
  transport: McpTransportType

  // stdio config (transport = 'stdio')
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string

  // HTTP config (transport = 'sse' | 'streamable-http')
  url?: string
  headers?: Record<string, string>

  // OAuth for HTTP transports; tokens are held by Main only (never in this config)
  auth?: McpServerAuthConfig

  // Auto-fallback: when transport = 'streamable-http' fails, retry with 'sse'
  autoFallback?: boolean

  // Metadata
  createdAt: number
  description?: string
}

/**
 * MCP server runtime status. `authorization-required` means the server answered
 * 401 and a browser authorization is pending; it is not a connection failure.
 */
export type McpServerStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'authorization-required'
  | 'error'

/** MCP Tool (capability from server) */
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

/** Full MCP server info for frontend display */
export interface McpServerInfo {
  config: McpServerConfig
  status: McpServerStatus
  tools: McpTool[]
  resources: McpResource[]
  prompts: McpPrompt[]
  error?: string
}
