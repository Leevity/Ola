// ── MCP System — Shared Types ──

import type {
  AdvertisedMcpTool,
  ExposedMcpTool,
  McpExposurePolicy,
  McpOutputLimits,
  McpPreflightConfig,
  McpServerDiagnostic
} from '../../shared/mcp-tool-policy'

export type {
  AdvertisedMcpTool,
  ExposedMcpTool,
  McpExposurePolicy,
  McpOutputLimits,
  McpPreflightConfig,
  McpServerDiagnostic
} from '../../shared/mcp-tool-policy'

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

  // ── Tool exposure ──

  /**
   * Short, immutable namespace for `mcp__<toolAlias>__<tool>`. Assigned by `McpConfigStore.add`
   * and frozen thereafter: the tool segment alone is not unique across servers, and recomputing
   * the namespace from the editable `name` would rename live tool identities and break transcripts
   * that recorded the old one.
   */
  toolAlias?: string
  /**
   * Model-facing allowlist of server tool names. Absent = every advertised tool is exposed
   * (legacy). An empty array is the opposite and means "expose nothing", which is why the store
   * never coerces absent to `[]`.
   */
  enabledTools?: string[]
  /** Named allowlists the user can switch between; only `activePreset` contributes to exposure. */
  toolPresets?: Record<string, string[]>
  activePreset?: string
  /** Host-side gates run before spawning a stdio child. */
  preflight?: McpPreflightConfig
  /** Skip preflight after it has explained itself. The result stays visible; only the gate relaxes. */
  ignorePreflight?: boolean
  /** Per-result size policy. Defaults keep the built-in 128 KB inline cap. */
  outputLimits?: McpOutputLimits
  /** Per-call timeout in ms. Absent uses the transport default. */
  timeoutMs?: number

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
  /** What the server advertises. Names and descriptions only — never registerable. */
  tools: AdvertisedMcpTool[]
  /**
   * One entry per advertised tool, with the external name Main already assigned. Entries with a
   * name are registerable; `filtered` and `reason` say why the rest are not. The renderer registers
   * these verbatim — a tool absent here is absent on purpose and is reported, never dropped quietly.
   */
  exposedTools: ExposedMcpTool[]
  /** The exposure policy actually in force, resolved for this server. */
  exposure: McpExposurePolicy
  resources: McpResource[]
  prompts: McpPrompt[]
  /**
   * True when capability discovery stopped at the page or entry ceiling, so `tools` is a partial
   * catalog. Without it the panel shows a short list as if the server advertised nothing else.
   * Tools that cannot be registered are not counted here: each stays in `exposedTools` with a
   * `reason`, which is the list the panel renders.
   */
  capabilitiesTruncated?: boolean
  error?: string
  diagnostic?: McpServerDiagnostic
}
