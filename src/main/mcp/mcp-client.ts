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
import type {
  ExposedMcpTool,
  McpExposurePolicy,
  McpOutputLimits,
  McpServerConfig,
  McpServerDiagnostic,
  McpServerStatus,
  McpTool,
  McpResource,
  McpPrompt
} from './mcp-types'
import { buildExposedMcpTools } from '../../shared/mcp-tool-policy'
import { isBlockingPreflightFailure, runMcpPreflight } from './mcp-preflight'
import { getMcpOAuthCredentialStore, McpOAuthCredentialStore } from './mcp-oauth-store'
import { McpOAuthProvider, serverScopedBackend } from './mcp-oauth-provider'
import { DEFAULT_MCP_OAUTH_PORT, redirectUriForPort } from './mcp-oauth-loopback'

/** Both HTTP transports can exchange a pending authorization code for tokens. */
type AuthorizableTransport = { finishAuth(code: string): Promise<void> }

/**
 * Pagination bounds for one capability list. A server that keeps handing back cursors would
 * otherwise spin here forever; stopping is visible because `_truncated` is reported to the panel.
 */
const MAX_CAPABILITY_PAGES = 32
const MAX_CAPABILITY_ENTRIES = 512
/** Calls without `timeoutMs` keep the SDK default; the ceiling stops a wedged child hanging a run. */
const MAX_CALL_TIMEOUT_MS = 30 * 60 * 1000

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
 * A host-side gate refused to spawn the child. Its own type exists so `autoconnect-coordinator`
 * can tell "this machine cannot run the server" apart from "the socket dropped" and stop retrying:
 * re-running the same preflight on the same host produces the same answer.
 */
export class McpPreflightError extends Error {
  readonly retryable = false
  constructor(
    readonly diagnostic: McpServerDiagnostic,
    serverName: string
  ) {
    super(`MCP preflight blocked "${serverName}": ${diagnostic.hint ?? diagnostic.code}`)
    this.name = 'McpPreflightError'
  }
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
  private _exposed: ExposedMcpTool[] = []
  private _unexposable = 0
  private _truncated = false
  private _diagnostic: McpServerDiagnostic | undefined

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
  /** Every tool the server advertises. Display and diagnostics only — not what the model may call. */
  get tools(): McpTool[] {
    return this._tools
  }
  /**
   * The tools the model may call, each carrying the external name Main registered it under.
   * Entries excluded by the allowlist or by an illegal name stay present with `filtered`/`reason`
   * set, so the panel can state exactly what is missing instead of a count quietly shrinking.
   */
  get exposedTools(): ExposedMcpTool[] {
    return this._exposed
  }
  /** Tool names with no legal external name; a number so the IPC payload stays small. */
  get unexposableToolCount(): number {
    return this._unexposable
  }
  get capabilitiesTruncated(): boolean {
    return this._truncated
  }
  get diagnostic(): McpServerDiagnostic | undefined {
    return this._diagnostic
  }
  /** The namespace every external name in `_exposed` was built from. */
  get toolAlias(): string {
    return this.config.toolAlias ?? ''
  }
  /**
   * The policy in force, read back from the live config rather than re-derived from the exposed
   * list: an absent allowlist means "everything" and must not become an explicit full list just
   * because a reconnect happened to enumerate every tool.
   */
  get exposurePolicy(): McpExposurePolicy {
    const policy: McpExposurePolicy = {}
    if (Array.isArray(this.config.enabledTools)) policy.enabledTools = this.config.enabledTools
    if (this.config.toolPresets && Object.keys(this.config.toolPresets).length)
      policy.toolPresets = this.config.toolPresets
    if (this.config.activePreset) policy.activePreset = this.config.activePreset
    return policy
  }
  get resources(): McpResource[] {
    return this._resources
  }
  get prompts(): McpPrompt[] {
    return this._prompts
  }
  get outputLimits(): McpOutputLimits | undefined {
    return this.config.outputLimits
  }
  /** The config this connection was built from, so a live view never has to fake one. */
  get serverConfig(): McpServerConfig {
    return this.config
  }
  get usedFallback(): boolean {
    return this._usedFallback
  }

  /** Re-read the exposure policy after `mcp:update` without reconnecting the transport. */
  applyConfig(config: McpServerConfig): void {
    this.config = config
    this.rebuildExposedTools()
  }

  private rebuildExposedTools(): void {
    const built = buildExposedMcpTools(this.toolAlias, this._tools, this.exposurePolicy)
    this._exposed = built.exposed
    this._unexposable = built.unexposable
    if (this._diagnostic?.code === 'TOOL_NOT_EXPOSABLE') this._diagnostic = undefined
    if (built.unexposable > 0) {
      this._diagnostic = {
        code: 'TOOL_NOT_EXPOSABLE',
        unexposableToolCount: built.unexposable,
        hint: `Server "${this.config.name}" advertises ${built.unexposable} tool(s) whose names cannot be exposed. Rename them upstream or narrow the allowlist.`
      }
    }
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
      // The gate runs before spawning, so the version reported is the one the child would get.
      const blocker = await this.preflightBlocker()
      if (blocker) {
        this._diagnostic = blocker
        this._status = 'error'
        this._error = `${blocker.detail ?? ''} — ${blocker.hint ?? 'Preflight failed'}`.trim()
        throw new McpPreflightError(blocker, this.config.name)
      }
      await this.tryConnect(this.config.transport)
    } catch (err) {
      if (err instanceof McpPreflightError) throw err
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
   * What preflight found, if anything should stop the connection. `ignorePreflight` downgrades a
   * failure to a visible note: the user still sees why the server is unusual, the gate just
   * releases. Connecting without the declared engine is the server's problem to report.
   */
  private async preflightBlocker(): Promise<McpServerDiagnostic | undefined> {
    if (this.config.transport !== 'stdio') return undefined
    if (!this.config.preflight) return undefined
    const found = await runMcpPreflight(this.config)
    if (!found) {
      if (this._diagnostic && isBlockingPreflightFailure(this._diagnostic))
        this._diagnostic = undefined
      return undefined
    }
    if (this.config.ignorePreflight === true) {
      this._diagnostic = found
      return undefined
    }
    return found
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
        `${this._tools.length} advertised, ${this._exposed.filter((tool) => tool.externalName).length} exposed` +
        `${this._resources.length ? `, ${this._resources.length} resources` : ''}` +
        `${this._prompts.length ? `, ${this._prompts.length} prompts` : ''}`
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
    this._exposed = []
    this._unexposable = 0
    this._truncated = false
    console.log(`[MCP:${this.config.name}] Disconnected`)
  }

  /** Refresh cached tools, resources, and prompts from the server */
  async refreshCapabilities(): Promise<void> {
    if (!this.client || this._status !== 'connected') return

    this._truncated = false
    try {
      try {
        this._tools = await this.fetchAllTools()
      } catch {
        this._tools = []
      }

      try {
        this._resources = await this.fetchAllResources()
      } catch {
        this._resources = []
      }

      try {
        this._prompts = await this.fetchAllPrompts()
      } catch {
        this._prompts = []
      }
    } catch (err) {
      console.error(`[MCP:${this.config.name}] Failed to refresh capabilities:`, err)
    } finally {
      this.rebuildExposedTools()
    }
  }

  /** Call a tool on the MCP server */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client || this._status !== 'connected') {
      throw new Error(`MCP server "${this.config.name}" is not connected`)
    }
    const timeoutMs = this.effectiveCallTimeoutMs()
    if (!timeoutMs) return await this.client.callTool({ name: toolName, arguments: args })
    // Raced rather than handed to the SDK: a child that never answers a `tools/call` would
    // otherwise hold the run open until the model gave up, with no error for the user to read.
    const request = this.client.callTool({ name: toolName, arguments: args })
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `MCP tool "${toolName}" on "${this.config.name}" timed out after ${Math.round(timeoutMs / 1000)}s`
          )
        )
      }, timeoutMs)
    })
    // The abandoned request keeps running; swallowing its late result keeps the process clean.
    void request.catch(() => undefined)
    try {
      return await Promise.race([request, deadline])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** `timeoutMs` clamped to the run ceiling; `undefined` keeps the SDK default. */
  private effectiveCallTimeoutMs(): number | undefined {
    const configured = this.config.timeoutMs
    if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0)
      return undefined
    return Math.min(Math.round(configured), MAX_CALL_TIMEOUT_MS)
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

    for (let page = 0; page < MAX_CAPABILITY_PAGES; page += 1) {
      const result = await this.client.listTools(cursor ? { cursor } : undefined)
      const pageTools = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>
      }))
      collected.push(...pageTools)
      cursor = result.nextCursor ?? undefined
      if (!cursor) return collected
      if (collected.length >= MAX_CAPABILITY_ENTRIES) {
        this._truncated = true
        console.warn(
          `[MCP:${this.config.name}] tool list stopped at ${collected.length}; the server advertises more`
        )
        return collected
      }
    }

    this._truncated = true
    console.warn(
      `[MCP:${this.config.name}] tool list stopped after ${MAX_CAPABILITY_PAGES} pages; the server keeps paginating`
    )
    return collected
  }

  /** Fetch all resources with pagination */
  private async fetchAllResources(): Promise<McpResource[]> {
    if (!this.client) return []

    const collected: McpResource[] = []
    let cursor: string | undefined

    for (let page = 0; page < MAX_CAPABILITY_PAGES; page += 1) {
      const result = await this.client.listResources(cursor ? { cursor } : undefined)
      const pageResources = (result.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType
      }))
      collected.push(...pageResources)
      cursor = result.nextCursor ?? undefined
      if (!cursor) return collected
      if (collected.length >= MAX_CAPABILITY_ENTRIES) {
        this._truncated = true
        return collected
      }
    }
    this._truncated = true
    return collected
  }

  /** Fetch all prompts with pagination */
  private async fetchAllPrompts(): Promise<McpPrompt[]> {
    if (!this.client) return []

    const collected: McpPrompt[] = []
    let cursor: string | undefined

    for (let page = 0; page < MAX_CAPABILITY_PAGES; page += 1) {
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
      if (!cursor) return collected
      if (collected.length >= MAX_CAPABILITY_ENTRIES) {
        this._truncated = true
        return collected
      }
    }
    this._truncated = true
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
