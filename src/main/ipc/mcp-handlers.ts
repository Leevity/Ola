import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc/contract'
import { isTrustedRendererIpcEvent } from '../renderer-security'
import { McpAutoConnectCoordinator } from '../mcp/autoconnect-coordinator'
import { McpConfigStore } from '../mcp/mcp-config-store'
import { McpManager } from '../mcp/mcp-manager'
import { getMcpOAuthCredentialStore } from '../mcp/mcp-oauth-store'
import {
  closeAllMcpOAuthLoopbacks,
  closeMcpOAuthLoopback,
  DEFAULT_MCP_OAUTH_PORT,
  startMcpOAuthLoopback,
  type McpOAuthCallbackResult,
  type McpOAuthCallbackVerdict
} from '../mcp/mcp-oauth-loopback'
import type { McpServerConfig, McpServerStatus } from '../mcp/mcp-types'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import { safeSendMessagePackToWindow } from '../window-ipc'

let activeMcpManager: McpManager | null = null
const mcpAutoConnectCoordinator = new McpAutoConnectCoordinator()
const mcpConfigStore = new McpConfigStore()
const mcpOAuthStore = getMcpOAuthCredentialStore()

/**
 * Window that started each pending authorization. The callback event goes back to
 * that window only, and a flow started elsewhere cannot be finished from here.
 */
const mcpOAuthWindows = new Map<string, BrowserWindow>()
const mcpOAuthWindowBindings = new WeakSet<BrowserWindow>()

type McpCallToolArgs = {
  serverId: string
  toolName: string
  args: Record<string, unknown>
}

type McpReadResourceArgs = {
  serverId: string
  uri?: string
  resourceName?: string
}

type McpOAuthStartResult = {
  success: boolean
  status?: McpServerStatus
  authorizationUrl?: string
  error?: string
}

type McpOAuthCallbackPayload = {
  serverId: string
  ok: boolean
  status: McpServerStatus
  error?: string
}

// ── Native config persistence ──

async function readServers(): Promise<McpServerConfig[]> {
  return await mcpConfigStore.list()
}

async function addServer(config: McpServerConfig): Promise<{ success: boolean; error?: string }> {
  return await mcpConfigStore.add(config)
}

async function updateServer(
  id: string,
  patch: Partial<McpServerConfig>
): Promise<{ success: boolean; error?: string }> {
  return await mcpConfigStore.update(id, patch)
}

async function removeServer(id: string): Promise<{ success: boolean; error?: string }> {
  return await mcpConfigStore.remove(id)
}

function isTrustedMcpIpcSender(event: IpcMainInvokeEvent): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  return (
    ownerWindow !== null &&
    !ownerWindow.isDestroyed() &&
    ownerWindow.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame &&
    isTrustedRendererIpcEvent(event)
  )
}

function registerMcpMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs, event: IpcMainInvokeEvent) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (event, bytes: Uint8Array) => {
    if (!isTrustedMcpIpcSender(event)) {
      throw new Error('Unauthorized MCP IPC sender')
    }
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args, event))
  })
}

// ── OAuth for HTTP MCP servers ──

/** Drop the pending flow for a window that closed before the browser came back. */
function bindMcpOAuthWindowLifecycle(win: BrowserWindow): void {
  if (mcpOAuthWindowBindings.has(win)) return
  mcpOAuthWindowBindings.add(win)
  win.on('closed', () => {
    for (const [serverId, pending] of mcpOAuthWindows) {
      if (pending === win) mcpOAuthWindows.delete(serverId)
    }
  })
}

function notifyMcpOAuthCallback(serverId: string, payload: McpOAuthCallbackPayload): void {
  const win = mcpOAuthWindows.get(serverId)
  if (!win || win.isDestroyed()) return
  safeSendMessagePackToWindow(win, IPC.MCP_OAUTH_CALLBACK, payload)
}

/**
 * Turn a loopback callback into a token exchange. The authorization code arrives
 * here and is spent here: it is never forwarded to the Renderer, and the Renderer
 * only learns whether the server is now usable.
 */
async function completeMcpOAuth(
  mcpManager: McpManager,
  serverId: string,
  result: McpOAuthCallbackResult
): Promise<McpOAuthCallbackVerdict> {
  const fail = (message: string): McpOAuthCallbackVerdict => {
    notifyMcpOAuthCallback(serverId, {
      serverId,
      ok: false,
      status: mcpManager.getStatus(serverId),
      error: message
    })
    return { accepted: false, message }
  }

  if (result.error) return fail(result.errorDescription ?? result.error)
  if (!result.code) return fail('The authorization server did not return a code')

  // CSRF check: fail closed. A missing expected state means no authorization URL has
  // been built yet (or the keychain read failed) — exchanging a code in that window
  // would let any local caller complete a flow with an arbitrary state.
  const expectedState = (await mcpOAuthStore.read(serverId)).state
  if (!expectedState || result.state !== expectedState) {
    return fail('Authorization state mismatch')
  }

  try {
    const status = await mcpManager.completeAuthorization(serverId, result.code)
    // The state and verifier are single-use: clear them so the callback cannot be replayed.
    await mcpOAuthStore.patch(serverId, { state: undefined, codeVerifier: undefined })
    notifyMcpOAuthCallback(serverId, { serverId, ok: true, status })
    return { accepted: true }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** App shutdown: no browser authorization can complete once the windows are gone. */
export function stopMcpOAuthFlows(): void {
  closeAllMcpOAuthLoopbacks()
  mcpOAuthWindows.clear()
}

export async function autoConnectMcpServers(mcpManager: McpManager): Promise<void> {
  const outcomes = await mcpAutoConnectCoordinator.connectEnabled(
    await readServers(),
    async (server) => await mcpManager.connectServer(server)
  )
  for (const outcome of outcomes) {
    if (outcome.status === 'failed') {
      console.error(
        `[MCP] Auto-connect failed for ${outcome.serverId} after ${outcome.attempts} attempts; ` +
          `circuit open until ${new Date(outcome.retryAt).toISOString()}: ${outcome.error}`
      )
    }
  }
}

// ── Register IPC handlers ──

export function registerMcpHandlers(mcpManager: McpManager): void {
  activeMcpManager = mcpManager

  // List all configured MCP servers
  registerMcpMessagePackHandler<undefined>('mcp:list', async () => {
    return await readServers()
  })

  // Read one configured MCP server without exposing the backing file to Renderer.
  registerMcpMessagePackHandler<string>('mcp:get', async (id) => {
    return await mcpConfigStore.get(id)
  })

  // Add a new MCP server config
  registerMcpMessagePackHandler<McpServerConfig>('mcp:add', async (config) => {
    return await addServer(config)
  })

  // Update an MCP server config
  registerMcpMessagePackHandler<{ id: string; patch: Partial<McpServerConfig> }>(
    'mcp:update',
    async ({ id, patch }) => {
      return await updateServer(id, patch)
    }
  )

  // Remove an MCP server config
  registerMcpMessagePackHandler<string>('mcp:remove', async (id) => {
    closeMcpOAuthLoopback(id)
    mcpOAuthWindows.delete(id)
    await mcpManager.disconnectServer(id)
    mcpAutoConnectCoordinator.reset(id)
    const removed = await removeServer(id)
    if (removed.success) await mcpOAuthStore.forget([id])
    return removed
  })

  // Connect to an MCP server
  registerMcpMessagePackHandler<string>('mcp:connect', async (id) => {
    const servers = await readServers()
    const config = servers.find((s) => s.id === id)
    if (!config) return { success: false, error: 'Server not found' }

    try {
      await mcpManager.connectServer(config)
      mcpAutoConnectCoordinator.reset(id)
      // `authorization-required` is a successful connect: the server answered, it
      // just wants a browser authorization before it will serve requests.
      return { success: true, status: mcpManager.getStatus(id) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  // Disconnect from an MCP server
  registerMcpMessagePackHandler<string>('mcp:disconnect', async (id) => {
    await mcpManager.disconnectServer(id)
    return { success: true }
  })

  // Get server status
  registerMcpMessagePackHandler<string>('mcp:status', (id) => {
    return mcpManager.getStatus(id)
  })

  // Get full server info (status + capabilities)
  registerMcpMessagePackHandler<string>('mcp:server-info', (id) => {
    return mcpManager.getServerInfo(id)
  })

  // Get all servers info (config + runtime status + capabilities)
  registerMcpMessagePackHandler<undefined>('mcp:all-servers-info', async () => {
    const servers = await readServers()
    return servers.map((config) => {
      const info = mcpManager.getServerInfo(config.id)
      return {
        config,
        status: info?.status ?? 'disconnected',
        tools: info?.tools ?? [],
        resources: info?.resources ?? [],
        prompts: info?.prompts ?? [],
        error: info?.error
      }
    })
  })

  // List tools for a specific server
  registerMcpMessagePackHandler<string>('mcp:list-tools', (id) => {
    return mcpManager.getTools(id)
  })

  // Call a tool on an MCP server
  registerMcpMessagePackHandler<McpCallToolArgs>('mcp:call-tool', async (args) => {
    return await executeMcpToolFromMain(args)
  })

  // Read a resource from an MCP server
  registerMcpMessagePackHandler<McpReadResourceArgs>('mcp:read-resource', async (args) => {
    return await readMcpResourceFromMain(args)
  })

  // List resources for a server
  registerMcpMessagePackHandler<string>('mcp:list-resources', (id) => {
    return mcpManager.getResources(id)
  })

  // Get a prompt from an MCP server
  registerMcpMessagePackHandler<{
    serverId: string
    promptName: string
    args?: Record<string, string>
  }>('mcp:get-prompt', async ({ serverId, promptName, args }) => {
    try {
      const result = await mcpManager.getPrompt(serverId, promptName, args)
      return { success: true, result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  // List prompts for a server
  registerMcpMessagePackHandler<string>('mcp:list-prompts', (id) => {
    return mcpManager.getPrompts(id)
  })

  // Refresh capabilities for a server
  registerMcpMessagePackHandler<string>('mcp:refresh-capabilities', async (id) => {
    try {
      await mcpManager.refreshCapabilities(id)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  /**
   * Start (or resume) a browser authorization for an HTTP MCP server.
   *
   * The loopback listener has to exist before the connection attempt: the SDK embeds
   * the redirect URI in both the authorization request and the dynamic client
   * registration, and offers no hook to change it mid-flow.
   */
  registerMcpMessagePackHandler<string>('mcp:oauth-start', async (id, event) => {
    const result: McpOAuthStartResult = { success: false }
    const config = (await readServers()).find((server) => server.id === id)
    if (!config) return { ...result, error: 'Server not found' }
    if (config.transport === 'stdio') {
      return { ...result, error: 'OAuth is only available for HTTP MCP servers' }
    }

    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return { ...result, error: 'Unauthorized MCP IPC sender' }

    try {
      const loopback = await startMcpOAuthLoopback({
        serverId: id,
        preferredPort: DEFAULT_MCP_OAUTH_PORT,
        onCallback: async (callback) => await completeMcpOAuth(mcpManager, id, callback)
      })
      // A new attempt invalidates whatever state/verifier the previous one left.
      await mcpOAuthStore.patch(id, {
        redirectUri: loopback.redirectUri,
        state: undefined,
        codeVerifier: undefined
      })

      mcpOAuthWindows.set(id, win)
      bindMcpOAuthWindowLifecycle(win)

      await mcpManager.connectServer(config)
      mcpAutoConnectCoordinator.reset(id)

      const status = mcpManager.getStatus(id)
      const authorizationUrl = mcpManager.getPendingAuthorizationUrl(id)
      if (authorizationUrl) {
        // Headless test runs must not pop a real browser window.
        if (process.env.OLA_E2E_DATA_ROOT === undefined) {
          await shell.openExternal(authorizationUrl)
        }
      } else if (status !== 'connected') {
        closeMcpOAuthLoopback(id)
        mcpOAuthWindows.delete(id)
        return { ...result, status, error: 'The server did not request an authorization' }
      }

      return { success: true, status, authorizationUrl }
    } catch (err) {
      closeMcpOAuthLoopback(id)
      mcpOAuthWindows.delete(id)
      return { ...result, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Forget the stored credentials and drop the client. The next connect (or
   * `mcp:oauth-start`) begins a fresh authorization from scratch.
   */
  registerMcpMessagePackHandler<string>('mcp:oauth-signout', async (id) => {
    closeMcpOAuthLoopback(id)
    mcpOAuthWindows.delete(id)
    await mcpManager.signOut(id)
    return { success: true, status: mcpManager.getStatus(id) }
  })
}

export function getActiveMcpManager(): McpManager {
  if (!activeMcpManager) {
    throw new Error('MCP manager is not initialized')
  }
  return activeMcpManager
}

export async function executeMcpToolFromMain({
  serverId,
  toolName,
  args
}: McpCallToolArgs): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    const result = await getActiveMcpManager().callTool(serverId, toolName, args)
    return { success: true, result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

export async function readMcpResourceFromMain({
  serverId,
  uri,
  resourceName
}: McpReadResourceArgs): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    const manager = getActiveMcpManager()
    const resolvedUri =
      uri ?? manager.getResources(serverId).find((resource) => resource.name === resourceName)?.uri

    if (!resolvedUri) {
      return {
        success: false,
        error: resourceName
          ? `MCP resource "${resourceName}" not found on server ${serverId}`
          : 'MCP resource uri is required'
      }
    }

    const result = await manager.readResource(serverId, resolvedUri)
    return { success: true, result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
