import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import {
  closeAllMcpOAuthLoopbacks,
  getMcpOAuthLoopback,
  startMcpOAuthLoopback
} from '../src/main/mcp/mcp-oauth-loopback.ts'

const client = await readFile('src/main/mcp/mcp-client.ts', 'utf8')
const handlers = await readFile('src/main/ipc/mcp-handlers.ts', 'utf8')
const loopback = await readFile('src/main/mcp/mcp-oauth-loopback.ts', 'utf8')
const provider = await readFile('src/main/mcp/mcp-oauth-provider.ts', 'utf8')
const store = await readFile('src/main/mcp/mcp-oauth-store.ts', 'utf8')
const contract = await readFile('src/shared/ipc/contract.ts', 'utf8')
const routing = await readFile('src/renderer/src/lib/ipc/messagepack-channel-routing.ts', 'utf8')
const packageJson = await readFile('package.json', 'utf8')

// ── Both HTTP transports must be able to start an authorization ──
assert.match(client, /authProvider: this\.provider/)
assert.equal(
  (client.match(/authProvider: this\.provider/g) ?? []).length,
  2,
  'both SSE and Streamable HTTP transports need an auth provider'
)
assert.match(client, /type AuthorizableTransport = \{ finishAuth\(code: string\): Promise<void> \}/)
assert.match(client, /await this\.transport\.finishAuth\(code\)/)
assert.match(
  client,
  /if \(\s*this\._status !== 'authorization-required' \|\| !isAuthorizable\(this\.transport\)\s*\)/
)
// A 401 must not be reported as a connection failure, and must not trigger the
// Streamable HTTP → SSE fallback (SSE cannot authorize either).
assert.match(
  client,
  /if \(isAuthorizationPending\(err\)\) \{\s*this\.enterAuthorizationRequired\(\)\s*return\s*\}/
)
assert.match(client, /error instanceof UnauthorizedError/)
assert.match(client, /error instanceof StreamableHTTPError\) return error\.code === 401/)
assert.match(client, /error instanceof SseError && error\.code === 401/)

// ── The provider owns only persistence; PKCE and discovery stay in the SDK ──
assert.match(provider, /implements OAuthClientProvider/)
assert.match(provider, /token_endpoint_auth_method: 'none'/)
assert.match(provider, /grant_types: \['authorization_code', 'refresh_token'\]/)
assert.match(provider, /redirect_uris: \[this\.options\.redirectUri\]/)
assert.match(provider, /async saveCodeVerifier\(codeVerifier: string\)/)
assert.match(provider, /if \(!verifier\) throw new Error\('No PKCE code verifier/)
assert.match(provider, /function serverScopedBackend\(/)
// No plaintext secret is ever kept next to the tokens.
assert.doesNotMatch(provider, /client_secret/)

// ── Credentials at rest ──
assert.match(store, /safeStorage\.encryptString/)
assert.match(store, /safeStorage\.decryptString/)
assert.match(store, /backend !== 'basic_text'/)
assert.match(store, /mode: 0o600/)
assert.match(store, /mode: 0o700/)
assert.match(store, /await rename\(temporary, this\.path\)/)
assert.match(store, /readyForCommit: waitForSafeStorageKeyPersistence/)
assert.match(store, /await this\.cryptography\.readyForCommit\?\.\(\)/)
// Unavailable keychain ⇒ memory only, never a plaintext file.
assert.match(store, /this\.memoryOnly = true/)
// Recovery must merge per field (a locked-keychain write touches one field and must not replace
// the tokens that only exist on disk) and replay deletions recorded during that window.
assert.match(store, /mergeMemoryOnlyWrites\(/)
assert.match(store, /for \(const field of cleared\.get\(serverId\) \?\? \[\]\)/)
assert.match(store, /this\.recordMemoryOnlyRemovals\(before, root\)/)
// The flush is a queued mutation, so it cannot interleave with a concurrent write.
assert.match(store, /await this\.flushMemoryOnlyWrites\(\)/)
assert.match(store, /if \(!this\.memoryOnly \|\| !this\.cryptography\.available\(\)\) return/)
assert.match(store, /export function getMcpOAuthCredentialStore\(\)/)

// ── The authorization code is spent in Main, never sent over IPC ──
assert.match(loopback, /export const MCP_OAUTH_CALLBACK_PATH = '\/mcp\/oauth\/callback'/)
assert.match(loopback, /requestUrl\.pathname !== MCP_OAUTH_CALLBACK_PATH/)
assert.match(loopback, /searchParams\.get\('code'\)/)
assert.match(loopback, /closeMcpOAuthLoopback\(params\.serverId\)/)
assert.match(loopback, /if \(error\.code !== 'EADDRINUSE' \|\| preferredPort === 0\) throw error/)

assert.match(handlers, /'mcp:oauth-start'/)
assert.match(handlers, /'mcp:oauth-signout'/)
assert.match(handlers, /await startMcpOAuthLoopback\(/)
// CSRF: the comparison must fail closed — a missing expected state is never a pass.
assert.match(handlers, /const expectedState = \(await mcpOAuthStore\.read\(serverId\)\)\.state/)
assert.match(handlers, /if \(!expectedState \|\| result\.state !== expectedState\)/)
assert.match(
  handlers,
  /await mcpOAuthStore\.patch\(serverId, \{ state: undefined, codeVerifier: undefined \}\)/
)
assert.match(handlers, /await mcpManager\.completeAuthorization\(serverId, result\.code\)/)
assert.match(handlers, /safeSendMessagePackToWindow\(win, IPC\.MCP_OAUTH_CALLBACK, payload\)/)
assert.match(handlers, /process\.env\.OLA_E2E_DATA_ROOT === undefined/)
assert.match(handlers, /export function stopMcpOAuthFlows\(\)/)
// Removing a server must not leave credentials behind.
assert.match(handlers, /await mcpOAuthStore\.forget\(\[id\]\)/)

// ── IPC contract and MessagePack routing are registered together ──
assert.match(contract, /MCP_OAUTH_START: 'mcp:oauth-start'/)
assert.match(contract, /MCP_OAUTH_SIGNOUT: 'mcp:oauth-signout'/)
assert.match(contract, /MCP_OAUTH_CALLBACK: 'mcp:oauth-callback'/)
for (const channel of ['mcp:oauth-start', 'mcp:oauth-signout']) {
  assert.ok(
    routing.includes(`'${channel}'`),
    `${channel} must be routed as a MessagePack invoke channel`
  )
}
assert.ok(
  routing.includes(`'mcp:oauth-callback'`),
  'mcp:oauth-callback must be routed as a MessagePack event channel'
)
// The Renderer never sends an authorization code, so no finish channel may exist.
assert.ok(!contract.includes('mcp:oauth-finish'))
assert.ok(!routing.includes('mcp:oauth-finish'))

assert.match(packageJson, /"verify:mcp-oauth"/)
assert.match(packageJson, /npm run verify:mcp-oauth/)
assert.match(packageJson, /verify:mcp-ipc-authorization && npm run verify:mcp-oauth/)

// ── Behavioural checks: run the real loopback listener, not just source greps ──
{
  closeAllMcpOAuthLoopbacks()
  const serverId = 'verify-oauth-loopback'
  let accept = false
  let callbacks = 0
  const loopback = await startMcpOAuthLoopback({
    serverId,
    preferredPort: 0,
    onCallback: () => {
      callbacks += 1
      return accept
        ? { accepted: true }
        : { accepted: false, message: 'denied <script>alert(1)</script>' }
    }
  })
  try {
    // A stray request with no code must not consume the pending authorization.
    const stray = await fetch(loopback.redirectUri)
    assert.equal(stray.status, 400)
    assert.equal(callbacks, 0)
    assert.ok(getMcpOAuthLoopback(serverId), 'stray request must not close the listener')
    await stray.text()

    // A rejected callback must keep the listener alive and escape attacker-controlled text.
    const rejected = await fetch(`${loopback.redirectUri}?code=abc&state=bad`)
    assert.equal(rejected.status, 400)
    const rejectedBody = await rejected.text()
    assert.ok(!rejectedBody.includes('<script>alert(1)</script>'))
    assert.ok(rejectedBody.includes('&lt;script&gt;'), 'callback HTML must be escaped')
    assert.ok(getMcpOAuthLoopback(serverId), 'rejected callback must not close the listener')

    // DNS-rebinding style Host headers are rejected before reaching Main.
    const hostileStatus = await new Promise<number>((resolve) => {
      const request = http.request(
        {
          hostname: new URL(loopback.redirectUri).hostname,
          port: loopback.port,
          path: '/mcp/oauth/callback?code=abc&state=bad',
          headers: { Host: 'evil.example.com' }
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        }
      )
      request.on('error', () => resolve(0))
      request.end()
    })
    assert.equal(hostileStatus, 400)
    assert.equal(callbacks, 1, 'a foreign Host must not reach the callback handler')
    assert.ok(getMcpOAuthLoopback(serverId))

    // Only a completed flow closes the listener.
    accept = true
    const completed = await fetch(`${loopback.redirectUri}?code=abc&state=good`)
    assert.equal(completed.status, 200)
    await completed.text()
    assert.equal(getMcpOAuthLoopback(serverId), undefined)
  } finally {
    closeAllMcpOAuthLoopbacks()
  }
}

console.log('MCP OAuth verification passed')
