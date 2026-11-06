// ── MCP Types for Renderer ──
// Mirror of Main's contract (src/main/mcp/mcp-types.ts). Shared policy types are imported from
// `src/shared/mcp-tool-policy` rather than copied, so the renderer cannot drift from Main's names.

import type {
  AdvertisedMcpTool,
  ExposedMcpTool,
  McpExposurePolicy,
  McpOutputLimits,
  McpPreflightConfig,
  McpServerDiagnostic
} from '../../../../shared/mcp-tool-policy'

export type {
  AdvertisedMcpTool,
  ExposedMcpTool,
  McpExposurePolicy,
  McpOutputLimits,
  McpPreflightConfig,
  McpServerDiagnostic
} from '../../../../shared/mcp-tool-policy'

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
  /** Immutable `mcp__<toolAlias>__<tool>` namespace; assigned by Main, never edited here. */
  toolAlias?: string
  /** Model-facing allowlist. Absent = expose all advertised tools; `[]` = expose nothing. */
  enabledTools?: string[]
  toolPresets?: Record<string, string[]>
  activePreset?: string
  preflight?: McpPreflightConfig
  ignorePreflight?: boolean
  outputLimits?: McpOutputLimits
  timeoutMs?: number
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

/** Full MCP server info; `tools` is advertised-only, `exposedTools` is what may be registered. */
export interface McpServerInfo {
  config: McpServerConfig
  status: McpServerStatus
  tools: AdvertisedMcpTool[]
  exposedTools: ExposedMcpTool[]
  exposure: McpExposurePolicy
  resources: McpResource[]
  prompts: McpPrompt[]
  /** Capability discovery stopped early, so `tools` is a partial catalog rather than the whole server. */
  capabilitiesTruncated?: boolean
  error?: string
  diagnostic?: McpServerDiagnostic
}
