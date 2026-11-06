import { McpClientWrapper } from './mcp-client'
import { getMcpOAuthCredentialStore } from './mcp-oauth-store'
import type {
  ExposedMcpTool,
  McpOutputLimits,
  McpServerConfig,
  McpServerInfo,
  McpServerStatus
} from './mcp-types'

/**
 * McpManager — manages multiple MCP server connections with lifecycle control.
 *
 * Similar pattern to PluginManager but for MCP protocol servers.
 */
export class McpManager {
  private clients = new Map<string, McpClientWrapper>()
  private readonly oauthStore = getMcpOAuthCredentialStore()

  /** Connect to an MCP server */
  async connectServer(config: McpServerConfig): Promise<void> {
    // Disconnect existing client if any
    if (this.clients.has(config.id)) {
      await this.disconnectServer(config.id)
    }

    const client = new McpClientWrapper(config, this.oauthStore)
    this.clients.set(config.id, client)

    try {
      await client.connect()
      if (client.status === 'authorization-required') {
        console.log(`[McpManager] Authorization required: ${config.name} (${config.id})`)
        return
      }
      console.log(`[McpManager] Connected: ${config.name} (${config.id})`)
    } catch (err) {
      console.error(`[McpManager] Failed to connect ${config.name}:`, err)
      throw err
    }
  }

  /** Disconnect an MCP server */
  async disconnectServer(id: string): Promise<void> {
    const client = this.clients.get(id)
    if (!client) return

    try {
      await client.disconnect()
      console.log(`[McpManager] Disconnected: ${id}`)
    } catch (err) {
      console.error(`[McpManager] Error disconnecting ${id}:`, err)
    } finally {
      this.clients.delete(id)
    }
  }

  /** Get pending authorization URL for a server awaiting browser authorization. */
  getPendingAuthorizationUrl(id: string): string | undefined {
    return this.clients.get(id)?.pendingAuthorizationUrl?.toString()
  }

  /**
   * Exchange an authorization code received by the loopback listener, then
   * reconnect. Runs entirely in Main: the code never reaches the Renderer.
   */
  async completeAuthorization(id: string, code: string): Promise<McpServerStatus> {
    const client = this.clients.get(id)
    if (!client) throw new Error(`MCP server ${id} is not connected`)
    await client.completeAuthorization(code)
    return client.status
  }

  /** Drop every stored credential for a server and disconnect it. */
  async signOut(id: string): Promise<void> {
    await this.disconnectServer(id)
    await this.oauthStore.clear(id, 'all')
  }

  /** Reconnect an MCP server */
  async reconnectServer(config: McpServerConfig): Promise<void> {
    await this.disconnectServer(config.id)
    await this.connectServer(config)
  }

  /**
   * Live view of one server, built from the config the connection actually runs with plus the
   * exposure the client resolved. `mcp:update` re-applies the stored config, so this never lags.
   */
  getServerInfo(id: string): McpServerInfo | undefined {
    const client = this.clients.get(id)
    if (!client) return undefined

    return {
      config: client.serverConfig,
      status: client.status,
      tools: client.tools.map((tool) => ({ name: tool.name, description: tool.description })),
      exposedTools: client.exposedTools,
      exposure: client.exposurePolicy,
      resources: client.resources,
      prompts: client.prompts,
      capabilitiesTruncated: client.capabilitiesTruncated,
      error: client.error,
      diagnostic: client.diagnostic
    }
  }

  /** Get status for a server */
  getStatus(id: string): McpServerStatus {
    const client = this.clients.get(id)
    return client?.status ?? 'disconnected'
  }

  /**
   * Tools the model may call, each with its external name. This is what the runtime registry and
   * the renderer both consume; `getAllTools` is the raw advertisement and must never be registered.
   */
  getTools(id: string): ExposedMcpTool[] {
    const client = this.clients.get(id)
    if (!client) return []
    return client.exposedTools.filter((tool) => Boolean(tool.externalName))
  }

  /** Every tool the server advertises, allowlist and naming included. Display only. */
  getAllTools(id: string): ExposedMcpTool[] {
    return this.clients.get(id)?.exposedTools ?? []
  }

  /** The namespace this server's external names use. Empty when the record predates aliases. */
  getToolAlias(id: string): string {
    return this.clients.get(id)?.toolAlias ?? ''
  }

  getOutputLimits(id: string): McpOutputLimits | undefined {
    return this.clients.get(id)?.outputLimits
  }

  /** Push a config edit — allowlist, presets, timeout — onto a live connection without reconnecting. */
  applyConfig(config: McpServerConfig): void {
    this.clients.get(config.id)?.applyConfig(config)
  }

  /** Get resources for a server */
  getResources(
    id: string
  ): { uri: string; name: string; description?: string; mimeType?: string }[] {
    const client = this.clients.get(id)
    return client?.resources ?? []
  }

  /** Get prompts for a server */
  getPrompts(id: string): {
    name: string
    description?: string
    arguments?: Array<{ name: string; description?: string; required?: boolean }>
  }[] {
    const client = this.clients.get(id)
    return client?.prompts ?? []
  }

  /** Call a tool on a specific MCP server */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const client = this.clients.get(serverId)
    if (!client) {
      throw new Error(`MCP server ${serverId} is not connected`)
    }
    return await client.callTool(toolName, args)
  }

  /** Read a resource from a specific MCP server */
  async readResource(serverId: string, uri: string): Promise<unknown> {
    const client = this.clients.get(serverId)
    if (!client) {
      throw new Error(`MCP server ${serverId} is not connected`)
    }
    return await client.readResource(uri)
  }

  /** Get a prompt from a specific MCP server */
  async getPrompt(
    serverId: string,
    promptName: string,
    args?: Record<string, string>
  ): Promise<unknown> {
    const client = this.clients.get(serverId)
    if (!client) {
      throw new Error(`MCP server ${serverId} is not connected`)
    }
    return await client.getPrompt(promptName, args)
  }

  /** Refresh capabilities for a server */
  async refreshCapabilities(serverId: string): Promise<void> {
    const client = this.clients.get(serverId)
    if (!client) return
    await client.refreshCapabilities()
  }

  /** Check if a server is connected */
  isConnected(id: string): boolean {
    const client = this.clients.get(id)
    return client?.status === 'connected'
  }

  /** Stable snapshot used when a Runtime run is created. */
  getConnectedServerIds(): string[] {
    return [...this.clients.entries()]
      .filter(([, client]) => client.status === 'connected')
      .map(([id]) => id)
      .sort()
  }

  /** Disconnect all servers (app shutdown) */
  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.clients.keys())
    await Promise.allSettled(ids.map((id) => this.disconnectServer(id)))
    console.log(`[McpManager] All MCP servers disconnected`)
  }
}
