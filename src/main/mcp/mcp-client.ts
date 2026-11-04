import { mkdirSync } from 'fs'
import { basename, join } from 'path'
import { olaDataRoot } from '../lib/ola-data-root'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { McpServerConfig, McpServerStatus, McpTool, McpResource, McpPrompt } from './mcp-types'
import { getMcpOAuthCredentialStore, McpOAuthCredentialStore } from './mcp-oauth-store'
import { McpOAuthProvider, serverScopedBackend } from './mcp-oauth-provider'
import { DEFAULT_MCP_OAUTH_PORT, redirectUriForPort } from './mcp-oauth-loopback'

/** Both HTTP transports can exchange a pending authorization code for tokens. */
type AuthorizableTransport = { finishAuth(code: string): Promise<void> }

function buildProcessEnv(): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) base[key] = value
  }
  return base
}

function isNpmCommand(command: string): boolean {
  const name = basename(command)
    .toLowerCase()
    .replace(/\.(cmd|exe)$/, '')
  return name === 'npm' || name === 'npx'
}

function defaultNpmCacheDir(): string {
  return join(olaDataRoot(), 'npm-cache')
}

function buildStdioEnv(
  command: string,
  configuredEnv?: Record<string, string>
): Record<string, string> | undefined {
  if (!configuredEnv && !isNpmCommand(command)) {
    return undefined
  }

  const env = { ...buildProcessEnv(), ...(configuredEnv ?? {}) }
  if (isNpmCommand(command) && !env.NPM_CONFIG_CACHE && !env.npm_config_cache) {
    const cacheDir = defaultNpmCacheDir()
    try {
      mkdirSync(cacheDir, { recursive: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[MCP] Failed to create npm cache dir ${cacheDir}: ${message}`)
    }
    env.NPM_CONFIG_CACHE = cacheDir
  }
  return env
}

/**
 * Whether a failure means "the server wants a browser authorization" rather than
 * "this server is broken". The SDK signals it with `UnauthorizedError`, or with a
 * transport-level 401 when the server answers before the auth flow can start.
 */
function isAuthorizationPending(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true
  if (error instanceof StreamableHTTPError) return error.code === 401
  // The SSE transport reports the status on its own error type.
  return error instanceof SseError && error.code === 401
}

/** Both HTTP transports expose `finishAuth`; stdio has no authorization at all. */
function isAuthorizable(transport: unknown): transport is AuthorizableTransport {
  return (
    typeof transport === 'object' &&
    transport !== null &&
    typeof (transport as AuthorizableTransport).finishAuth === 'function'
  )
}

/**
 * McpClientWrapper — wraps @modelcontextprotocol/sdk Client for a single MCP server.
 *
 * Handles transport creation (stdio / SSE / Streamable HTTP),
 * auto-fallback from Streamable HTTP → SSE, OAuth for HTTP transports,
 * and capability caching.
 */
export class McpClientWrapper {
  private client: Client | null = null
  private transport:
    | InstanceType<typeof StdioClientTransport>
    | InstanceType<typeof SSEClientTransport>
    | InstanceType<typeof StreamableHTTPClientTransport>
    | null = null
  private provider: McpOAuthProvider | undefined

  private _status: McpServerStatus = 'disconnected'
  private _error: string | undefined
  private _tools: McpTool[] = []
  private _resources: McpResource[] = []
  private _prompts: McpPrompt[] = []
  private _usedFallback = false

  constructor(
    private config: McpServerConfig,
    private readonly credentials: McpOAuthCredentialStore = getMcpOAuthCredentialStore()
  ) {}

  get status(): McpServerStatus {
    return this._status
  }
  get error(): string | undefined {
    return this._error
  }
  get tools(): McpTool[] {
    return this._tools
  }
  get resources(): McpResource[] {
    return this._resources
  }
  get prompts(): McpPrompt[] {
    return this._prompts
  }
  get usedFallback(): boolean {
    return this._usedFallback
  }

  /** The authorization URL the server redirected to, once the SDK produced one. */
  get pendingAuthorizationUrl(): URL | undefined {
    return this.provider?.pendingAuthorizationUrl
  }

  /** Connect to the MCP server using the configured transport */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') return

    this._status = 'connecting'
    this._error = undefined
    this._usedFallback = false

    try {
      await this.tryConnect(this.config.transport)
    } catch (err) {
      // A 401 is not a failure: the server is waiting for a browser authorization.
      // Neither retrying nor falling back to SSE can succeed before that happens.
      if (isAuthorizationPending(err)) {
        this.enterAuthorizationRequired()
        return
      }

      // Auto-fallback: Streamable HTTP → SSE
      if (
        this.config.transport === 'streamable-http' &&
        this.config.autoFallback !== false &&
        this.config.url
      ) {
        console.log(`[MCP:${this.config.name}] Streamable HTTP failed, falling back to SSE...`)
        try {
          await this.tryConnect('sse')
          this._usedFallback = true
          return
        } catch (fallbackErr) {
          if (isAuthorizationPending(fallbackErr)) {
            this.enterAuthorizationRequired()
            return
          }
          const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
          this._status = 'error'
          this._error = `Streamable HTTP and SSE fallback both failed: ${msg}`
          throw new Error(this._error)
        }
      }

      const msg = err instanceof Error ? err.message : String(err)
      this._status = 'error'
      this._error = msg
      throw err
    }
  }

  /**
   * Exchange the authorization code the loopback listener received. The code is
   * handed to Main directly and never reaches the Renderer.
   */
  async completeAuthorization(code: string): Promise<void> {
    if (this._status !== 'authorization-required' || !isAuthorizable(this.transport)) {
      throw new Error(`MCP server "${this.config.name}" has no pending authorization`)
    }
    await this.transport.finishAuth(code)
    // The OAuth round trip is over: the authorized transport is not reusable,
    // a fresh connect picks up the stored bearer token.
    await this.cleanupClient()
    this._status = 'disconnected'
    await this.connect()
  }

  /**
   * Keep the transport that received the 401: it carries the resource metadata and
   * scope the server advertised, which `finishAuth` needs. The Client that owned it
   * is discarded — its only resource is that transport.
   */
  private enterAuthorizationRequired(): void {
    this.client = null
    this._status = 'authorization-required'
    this._error = undefined
    console.log(`[MCP:${this.config.name}] Authorization required`)
  }

  /** Internal: attempt connection with a specific transport type */
  private async tryConnect(transportType: string): Promise<void> {
    // Clean up any existing client
    await this.cleanupClient()

    this.client = new Client({ name: 'Ola', version: '1.0.0' }, { capabilities: {} })

    this.provider = await this.createAuthProvider(transportType)
    this.transport = this.createTransport(transportType)
    await this.client.connect(this.transport)

    this._status = 'connected'
    this._error = undefined

    // Cache capabilities
    await this.refreshCapabilities()

    console.log(
      `[MCP:${this.config.name}] Connected via ${transportType} — ` +
        `${this._tools.length} tools, ${this._resources.length} resources, ${this._prompts.length} prompts`
    )
  }

  /**
   * HTTP transports get an auth provider so a 401 becomes a discoverable
   * authorization request instead of a connection failure. stdio servers are
   * authenticated by their own environment, never by OAuth.
   *
   * Building the provider never navigates a browser: `redirectToAuthorization` only
   * records the URL, and the IPC layer decides what to do with it.
   */
  private async createAuthProvider(transportType: string): Promise<McpOAuthProvider | undefined> {
    if (transportType !== 'sse' && transportType !== 'streamable-http') return undefined

    const stored = await this.credentials.read(this.config.id)
    const redirectUri = stored.redirectUri ?? redirectUriForPort(DEFAULT_MCP_OAUTH_PORT)
    return new McpOAuthProvider({
      redirectUri,
      clientName: 'Ola',
      scope: this.config.auth?.scope,
      clientId: this.config.auth?.clientId,
      backend: serverScopedBackend(this.credentials, this.config.id)
    })
  }

  /** Create the transport instance based on type */
  private createTransport(
    transportType: string
  ):
    | InstanceType<typeof StdioClientTransport>
    | InstanceType<typeof SSEClientTransport>
    | InstanceType<typeof StreamableHTTPClientTransport> {
    switch (transportType) {
      case 'stdio':
        if (!this.config.command) {
          throw new Error('stdio transport requires a command')
        }
        {
          const mergedEnv = buildStdioEnv(this.config.command, this.config.env)
          return new StdioClientTransport({
            command: this.config.command,
            args: this.config.args,
            env: mergedEnv,
            cwd: this.config.cwd
          })
        }

      case 'sse':
        if (!this.config.url) {
          throw new Error('SSE transport requires a URL')
        }
        return new SSEClientTransport(new URL(this.config.url), {
          requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
          authProvider: this.provider
        })

      case 'streamable-http':
        if (!this.config.url) {
          throw new Error('Streamable HTTP transport requires a URL')
        }
        return new StreamableHTTPClientTransport(new URL(this.config.url), {
          requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
          authProvider: this.provider
        })

      default:
        throw new Error(`Unknown transport type: ${transportType}`)
    }
  }

  /** Disconnect from the MCP server */
  async disconnect(): Promise<void> {
    await this.cleanupClient()
    this._status = 'disconnected'
    this._error = undefined
    this._tools = []
    this._resources = []
    this._prompts = []
    console.log(`[MCP:${this.config.name}] Disconnected`)
  }

  /** Refresh cached tools, resources, and prompts from the server */
  async refreshCapabilities(): Promise<void> {
    if (!this.client || this._status !== 'connected') return

    try {
      // List tools (handle pagination)
      try {
        this._tools = await this.fetchAllTools()
      } catch {
        this._tools = []
      }

      // List resources (handle pagination)
      try {
        this._resources = await this.fetchAllResources()
      } catch {
        this._resources = []
      }

      // List prompts (handle pagination)
      try {
        this._prompts = await this.fetchAllPrompts()
      } catch {
        this._prompts = []
      }
    } catch (err) {
      console.error(`[MCP:${this.config.name}] Failed to refresh capabilities:`, err)
    }
  }

  /** Call a tool on the MCP server */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client || this._status !== 'connected') {
      throw new Error(`MCP server "${this.config.name}" is not connected`)
    }
    const result = await this.client.callTool({ name: toolName, arguments: args })
    return result
  }

  /** Read a resource from the MCP server */
  async readResource(uri: string): Promise<unknown> {
    if (!this.client || this._status !== 'connected') {
      throw new Error(`MCP server "${this.config.name}" is not connected`)
    }
    const result = await this.client.readResource({ uri })
    return result
  }

  /** Get a prompt from the MCP server */
  async getPrompt(name: string, args?: Record<string, string>): Promise<unknown> {
    if (!this.client || this._status !== 'connected') {
      throw new Error(`MCP server "${this.config.name}" is not connected`)
    }
    const result = await this.client.getPrompt({ name, arguments: args })
    return result
  }

  /** Fetch all tools with pagination */
  private async fetchAllTools(): Promise<McpTool[]> {
    if (!this.client) return []

    const collected: McpTool[] = []
    let cursor: string | undefined

    do {
      const result = await this.client.listTools(cursor ? { cursor } : undefined)
      const pageTools = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>
      }))
      collected.push(...pageTools)
      cursor = result.nextCursor ?? undefined
    } while (cursor)

    return collected
  }

  /** Fetch all resources with pagination */
  private async fetchAllResources(): Promise<McpResource[]> {
    if (!this.client) return []

    const collected: McpResource[] = []
    let cursor: string | undefined

    do {
      const result = await this.client.listResources(cursor ? { cursor } : undefined)
      const pageResources = (result.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType
      }))
      collected.push(...pageResources)
      cursor = result.nextCursor ?? undefined
    } while (cursor)

    return collected
  }

  /** Fetch all prompts with pagination */
  private async fetchAllPrompts(): Promise<McpPrompt[]> {
    if (!this.client) return []

    const collected: McpPrompt[] = []
    let cursor: string | undefined

    do {
      const result = await this.client.listPrompts(cursor ? { cursor } : undefined)
      const pagePrompts = (result.prompts ?? []).map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments?.map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required
        }))
      }))
      collected.push(...pagePrompts)
      cursor = result.nextCursor ?? undefined
    } while (cursor)

    return collected
  }

  /** Clean up existing client and transport */
  private async cleanupClient(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // Ignore close errors
      }
      this.client = null
    }
    if (this.transport) {
      try {
        await this.transport.close()
      } catch {
        // Ignore close errors
      }
      this.transport = null
    }
  }
}
