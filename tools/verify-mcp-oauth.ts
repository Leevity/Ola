import assert from 'node:assert/strict'
import http from 'node:http'
import {
  closeAllMcpOAuthLoopbacks,
  getMcpOAuthLoopback,
  startMcpOAuthLoopback
} from '../src/main/mcp/mcp-oauth-loopback.ts'
import { readCollapsedSource } from './lib/source-text.ts'

// Every assertion here is about code, not layout. Collapsing turns a wrapped list into
// `[ 'a', 'b' ]` and a wrapped call into `f( arg )`, so each pattern tolerates a space
// wherever the formatter may break a line. The security invariants — PKCE verifier, CSRF
// state, credential revocation, code-spent-in-Main — are asserted exactly as before.
const client = await readCollapsedSource('src/main/mcp/mcp-client.ts')
const handlers = await readCollapsedSource('src/main/ipc/mcp-handlers.ts')
const loopback = await readCollapsedSource('src/main/mcp/mcp-oauth-loopback.ts')
const provider = await readCollapsedSource('src/main/mcp/mcp-oauth-provider.ts')
const store = await readCollapsedSource('src/main/mcp/mcp-oauth-store.ts')
const contract = await readCollapsedSource('src/shared/ipc/contract.ts')
const routing = await readCollapsedSource('src/renderer/src/lib/ipc/messagepack-channel-routing.ts')
const packageJson = await readCollapsedSource('package.json')

// ── Both HTTP transports must be able to start an authorization ──
const authProviderBinding = /authProvider:\s*this\s*\.\s*provider/
assert.match(client, authProviderBinding)
assert.equal(
  (client.match(new RegExp(authProviderBinding.source, 'g')) ?? []).length,
  2,
  'both SSE and Streamable HTTP transports need an auth provider'
)
assert.match(
  client,
  /type AuthorizableTransport =\s*\{\s*finishAuth\(\s*code:\s*string\s*\):\s*Promise<void>\s*\}/
)
assert.match(client, /await this\s*\.\s*transport\s*\.\s*finishAuth\(\s*code\s*\)/)
assert.match(
  client,
  /if \(\s*this\s*\.\s*_status !== 'authorization-required' \|\| !isAuthorizable\(\s*this\s*\.\s*transport\s*\)\s*\)/
)
// A 401 must not be reported as a connection failure, and must not trigger the
// Streamable HTTP → SSE fallback (SSE cannot authorize either).
assert.match(
  client,
  /if \(isAuthorizationPending\(\s*err\s*\)\)\s*\{\s*this\s*\.\s*enterAuthorizationRequired\(\s*\)\s*return\s*\}/
)
assert.match(client, /error instanceof UnauthorizedError/)
assert.match(client, /error instanceof StreamableHTTPError\s*\)\s*return error\s*\.\s*code === 401/)
assert.match(client, /error instanceof SseError && error\s*\.\s*code === 401/)

// ── The provider owns only persistence; PKCE and discovery stay in the SDK ──
assert.match(provider, /implements OAuthClientProvider/)
assert.match(provider, /token_endpoint_auth_method:\s*'none'/)
assert.match(provider, /grant_types:\s*\[\s*'authorization_code',\s*'refresh_token'\s*\]/)
assert.match(provider, /redirect_uris:\s*\[\s*this\s*\.\s*options\s*\.\s*redirectUri\s*\]/)
assert.match(provider, /async saveCodeVerifier\(\s*codeVerifier:\s*string\s*\)/)
assert.match(provider, /if \(\s*!verifier\s*\)\s*throw new Error\(\s*'No PKCE code verifier/)
assert.match(provider, /function serverScopedBackend\(/)
// No plaintext secret is ever kept next to the tokens.
assert.doesNotMatch(provider, /client_secret/)

// ── Credentials at rest ──
assert.match(store, /safeStorage\s*\.\s*encryptString/)
assert.match(store, /safeStorage\s*\.\s*decryptString/)
assert.match(store, /backend !== 'basic_text'/)
assert.match(store, /mode:\s*0o600/)
assert.match(store, /mode:\s*0o700/)
assert.match(store, /await rename\(\s*temporary,\s*this\s*\.\s*path\s*\)/)
assert.match(store, /readyForCommit:\s*waitForSafeStorageKeyPersistence/)
assert.match(store, /await this\s*\.\s*cryptography\s*\.\s*readyForCommit\?\s*\.\s*\(\s*\)/)
// Unavailable keychain ⇒ memory only, never a plaintext file.
assert.match(store, /this\s*\.\s*memoryOnly = true/)
// Recovery must merge per field (a locked-keychain write touches one field and must not replace
// the tokens that only exist on disk) and replay deletions recorded during that window.
assert.match(store, /mergeMemoryOnlyWrites\(/)
assert.match(store, /for \(const field of cleared\s*\.\s*get\(\s*serverId\s*\) \?\? \[\s*\]\)/)
assert.match(store, /this\s*\.\s*recordMemoryOnlyRemovals\(\s*before,\s*root\s*\)/)
// The flush is a queued mutation, so it cannot interleave with a concurrent write.
assert.match(store, /await this\s*\.\s*flushMemoryOnlyWrites\(\s*\)/)
assert.match(
  store,
  /if \(\s*!this\s*\.\s*memoryOnly \|\| !this\s*\.\s*cryptography\s*\.\s*available\(\s*\)\s*\)\s*return/
)
assert.match(store, /export function getMcpOAuthCredentialStore\(\s*\)/)

// ── The authorization code is spent in Main, never sent over IPC ──
assert.match(loopback, /export const MCP_OAUTH_CALLBACK_PATH =\s*'\/mcp\/oauth\/callback'/)
assert.match(loopback, /requestUrl\s*\.\s*pathname !== MCP_OAUTH_CALLBACK_PATH/)
assert.match(loopback, /searchParams\s*\.\s*get\(\s*'code'\s*\)/)
assert.match(loopback, /closeMcpOAuthLoopback\(\s*params\s*\.\s*serverId\s*\)/)
assert.match(
  loopback,
  /if \(\s*error\s*\.\s*code !== 'EADDRINUSE' \|\| preferredPort === 0\s*\)\s*throw error/
)

assert.match(handlers, /'mcp:oauth-start'/)
assert.match(handlers, /'mcp:oauth-signout'/)
assert.match(handlers, /await startMcpOAuthLoopback\(/)
// CSRF: the comparison must fail closed — a missing expected state is never a pass.
assert.match(
  handlers,
  /const expectedState =\s*\(\s*await mcpOAuthStore\s*\.\s*read\(\s*serverId\s*\)\s*\)\s*\.\s*state/
)
assert.match(handlers, /if \(\s*!expectedState \|\| result\s*\.\s*state !== expectedState\s*\)/)
assert.match(
  handlers,
  /await mcpOAuthStore\s*\.\s*patch\(\s*serverId,\s*\{\s*state: undefined,\s*codeVerifier: undefined\s*\}\s*\)/
)
assert.match(
  handlers,
  /await mcpManager\s*\.\s*completeAuthorization\(\s*serverId,\s*result\s*\.\s*code\s*\)/
)
assert.match(
  handlers,
  /safeSendMessagePackToWindow\(\s*win,\s*IPC\s*\.\s*MCP_OAUTH_CALLBACK,\s*payload\s*\)/
)
assert.match(handlers, /process\s*\.\s*env\s*\.\s*OLA_E2E_DATA_ROOT === undefined/)
assert.match(handlers, /export function stopMcpOAuthFlows\(\s*\)/)
// Removing a server must not leave credentials behind.
assert.match(handlers, /await mcpOAuthStore\s*\.\s*forget\(\s*\[\s*id\s*\]\s*\)/)

// ── IPC contract and MessagePack routing are registered together ──
assert.match(contract, /MCP_OAUTH_START:\s*'mcp:oauth-start'/)
assert.match(contract, /MCP_OAUTH_SIGNOUT:\s*'mcp:oauth-signout'/)
assert.match(contract, /MCP_OAUTH_CALLBACK:\s*'mcp:oauth-callback'/)
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
