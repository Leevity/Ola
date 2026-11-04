import * as http from 'node:http'
import { URL } from 'node:url'

/** Redirect path the MCP authorization server sends the browser back to. */
export const MCP_OAUTH_CALLBACK_PATH = '/mcp/oauth/callback'

/**
 * Preferred loopback port. A stable port keeps the redirect URI (and therefore the
 * dynamic client registration) valid across restarts; when it is taken the flow
 * still works on an ephemeral port, it just re-registers.
 */
export const DEFAULT_MCP_OAUTH_PORT = 43117

const DEFAULT_TIMEOUT_MS = 10 * 60_000

export interface McpOAuthCallbackResult {
  code?: string
  state?: string | null
  error?: string
  errorDescription?: string
}

export interface McpOAuthCallbackVerdict {
  accepted: boolean
  message?: string
}

export interface McpOAuthLoopback {
  readonly serverId: string
  readonly port: number
  readonly redirectUri: string
  close(): void
}

interface LoopbackEntry {
  readonly loopback: McpOAuthLoopback
  readonly server: http.Server
  timer: NodeJS.Timeout | undefined
}

const activeLoopbacks = new Map<string, LoopbackEntry>()

export function redirectUriForPort(port: number): string {
  return `http://localhost:${port}${MCP_OAUTH_CALLBACK_PATH}`
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}

function renderCallbackPage(title: string, message: string): string {
  const safeTitle = escapeHtml(title)
  const safeMessage = escapeHtml(message)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 32px; color: #111; }
    .card { max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #ddd; border-radius: 12px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { margin: 0; color: #555; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
  </div>
</body>
</html>`
}

/**
 * Loopback redirect listener for one MCP server. The authorization code is read here
 * and handed straight to Main; it never crosses IPC, and neither do the tokens.
 */
export async function startMcpOAuthLoopback(params: {
  serverId: string
  onCallback: (
    result: McpOAuthCallbackResult
  ) => McpOAuthCallbackVerdict | Promise<McpOAuthCallbackVerdict>
  preferredPort?: number
  timeoutMs?: number
}): Promise<McpOAuthLoopback> {
  const existing = activeLoopbacks.get(params.serverId)
  if (existing) {
    armTimeout(params.serverId, params.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    return existing.loopback
  }

  const handleRequest = async (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> => {
    // Bind the listener to the loopback origin: a DNS-rebinding page resolving to
    // 127.0.0.1 arrives with its own Host header and must not reach the flow.
    const hostHeader = (request.headers.host ?? '').toLowerCase()
    const hostname = hostHeader.startsWith('[')
      ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
      : (hostHeader.split(':')[0] ?? '')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
      response.statusCode = 400
      response.end('Bad Request')
      return
    }

    const requestUrl = new URL(request.url || '', 'http://localhost')
    if (requestUrl.pathname !== MCP_OAUTH_CALLBACK_PATH) {
      response.statusCode = 404
      response.end('Not Found')
      return
    }

    const result: McpOAuthCallbackResult = {
      code: requestUrl.searchParams.get('code') ?? undefined,
      state: requestUrl.searchParams.get('state'),
      error: requestUrl.searchParams.get('error') ?? undefined,
      errorDescription: requestUrl.searchParams.get('error_description') ?? undefined
    }

    // A callback carrying neither a code nor an error is not an authorization
    // attempt. Reject it without invoking Main and without consuming the listener,
    // so a stray local request cannot cancel a pending login.
    if (!result.code && !result.error) {
      response.statusCode = 400
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(renderCallbackPage('Authorization failed', 'Missing authorization code.'))
      return
    }

    let verdict: McpOAuthCallbackVerdict
    try {
      verdict = await params.onCallback(result)
    } catch (error) {
      verdict = {
        accepted: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }

    response.statusCode = verdict.accepted ? 200 : 400
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(
      verdict.accepted
        ? renderCallbackPage('Authorization completed', 'You can close this window.')
        : renderCallbackPage(
            'Authorization failed',
            verdict.message ?? 'The authorization request was rejected.'
          )
    )
    // Only a completed flow closes the listener. A rejected callback (bad state,
    // transient exchange failure) must leave it alive for the legitimate browser.
    if (verdict.accepted) closeMcpOAuthLoopback(params.serverId)
  }

  const server = await listen(handleRequest, params.preferredPort ?? DEFAULT_MCP_OAUTH_PORT)
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const entry: LoopbackEntry = {
    loopback: {
      serverId: params.serverId,
      port,
      redirectUri: redirectUriForPort(port),
      close: () => closeMcpOAuthLoopback(params.serverId)
    },
    server,
    timer: undefined
  }
  activeLoopbacks.set(params.serverId, entry)
  armTimeout(params.serverId, params.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  return entry.loopback
}

export function getMcpOAuthLoopback(serverId: string): McpOAuthLoopback | undefined {
  return activeLoopbacks.get(serverId)?.loopback
}

export function closeMcpOAuthLoopback(serverId: string): void {
  const entry = activeLoopbacks.get(serverId)
  if (!entry) return
  activeLoopbacks.delete(serverId)
  if (entry.timer) clearTimeout(entry.timer)
  try {
    entry.server.close()
  } catch {
    // Already closed; nothing to release.
  }
}

export function closeAllMcpOAuthLoopbacks(): void {
  for (const serverId of [...activeLoopbacks.keys()]) closeMcpOAuthLoopback(serverId)
}

function armTimeout(serverId: string, timeoutMs: number): void {
  const entry = activeLoopbacks.get(serverId)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => closeMcpOAuthLoopback(serverId), timeoutMs)
  entry.timer.unref?.()
}

function listen(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  preferredPort: number
): Promise<http.Server> {
  const attempt = (port: number): Promise<http.Server> =>
    new Promise<http.Server>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void handler(request, response)
      })
      server.once('error', reject)
      server.listen(port, 'localhost', () => {
        server.off('error', reject)
        resolve(server)
      })
    })

  return attempt(preferredPort).catch((error: NodeJS.ErrnoException) => {
    // The preferred port is only a convenience; fall back to an ephemeral one.
    if (error.code !== 'EADDRINUSE' || preferredPort === 0) throw error
    return attempt(0)
  })
}
