import { randomUUID } from 'node:crypto'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { McpOAuthCredentialScope, McpOAuthCredentials } from './mcp-oauth-store'

/** The subset of the credential store the provider needs; keeps the provider testable. */
export interface McpOAuthStateBackend {
  read(): Promise<McpOAuthCredentials>
  patch(change: Partial<McpOAuthCredentials>): Promise<void>
  clear(scope: McpOAuthCredentialScope): Promise<void>
}

export interface McpOAuthProviderOptions {
  /**
   * Loopback URL the authorization server redirects back to. It must be final
   * before discovery starts: the SDK embeds it in the authorization request.
   */
  redirectUri: string
  clientName?: string
  scope?: string
  /**
   * Pre-registered public client. When absent the authorization server's dynamic
   * registration endpoint is used; PKCE covers the public-client case either way.
   */
  clientId?: string
  /** Receives the authorization URL instead of navigating a browser directly. */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>
  backend: McpOAuthStateBackend
}

/**
 * Persists what the SDK's authorization flow needs across calls and restarts.
 *
 * PKCE generation, metadata discovery, refresh and the code exchange all live in
 * the SDK. This provider only owns the parts that must survive a restart: the
 * client registration, the CSRF state, the PKCE verifier, and the tokens. It never
 * hands credentials to the Renderer.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private authorizationUrl: URL | undefined

  constructor(private readonly options: McpOAuthProviderOptions) {}

  /** The URL recorded during `redirectToAuthorization`, surfaced to the UI. */
  get pendingAuthorizationUrl(): URL | undefined {
    return this.authorizationUrl
  }

  get redirectUrl(): string {
    return this.options.redirectUri
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      redirect_uris: [this.options.redirectUri],
      client_name: this.options.clientName ?? 'Ola',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
    if (this.options.scope) metadata.scope = this.options.scope
    return metadata
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = (await this.readState()).clientInformation
    if (stored) return stored
    // A pre-registered public client only needs its id; the SDK skips dynamic
    // registration once this is answered, and PKCE still binds the code exchange.
    if (this.options.clientId) return { client_id: this.options.clientId }
    return undefined
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.patch({ clientInformation })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.readState()).tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const expiresAt =
      typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)
        ? Date.now() + tokens.expires_in * 1000
        : undefined
    await this.patch({ tokens, expiresAt })
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.patch({ codeVerifier })
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.readState()).codeVerifier
    if (!verifier) throw new Error('No PKCE code verifier for this authorization')
    return verifier
  }

  async state(): Promise<string> {
    const current = await this.readState()
    if (current.state) return current.state
    const state = randomUUID()
    await this.patch({ state })
    return state
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.authorizationUrl = authorizationUrl
    await this.options.onAuthorizationUrl?.(authorizationUrl)
  }

  async invalidateCredentials(scope: McpOAuthCredentialScope): Promise<void> {
    await this.options.backend.clear(scope)
    if (scope !== 'verifier') this.authorizationUrl = undefined
  }

  private readState(): Promise<McpOAuthCredentials> {
    return this.options.backend.read()
  }

  private patch(change: Partial<McpOAuthCredentials>): Promise<void> {
    return this.options.backend.patch(change)
  }
}

/** Wraps the shared store so one provider can only ever touch its own server. */
export function serverScopedBackend(
  store: {
    read(serverId: string): Promise<McpOAuthCredentials>
    patch(serverId: string, change: Partial<McpOAuthCredentials>): Promise<void>
    clear(serverId: string, scope?: McpOAuthCredentialScope): Promise<void>
  },
  serverId: string
): McpOAuthStateBackend {
  return {
    read: () => store.read(serverId),
    patch: (change) => store.patch(serverId, change),
    clear: (scope) => store.clear(serverId, scope)
  }
}
