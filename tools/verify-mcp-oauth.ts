import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

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
assert.match(
  store,
  /if \(!this\.cryptography\.available\(\)\) \{\s*this\.memory = root\s*return\s*\}/
)
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
// CSRF: the state persisted when the authorization URL was built is compared here.
assert.match(handlers, /const expectedState = \(await mcpOAuthStore\.read\(serverId\)\)\.state/)
assert.match(handlers, /if \(expectedState && result\.state !== expectedState\)/)
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

console.log('MCP OAuth verification passed')
