import type { ModelSource } from './model-source'

/**
 * Public, non-secret metadata for an execution location. A workspace is an
 * authorization/data boundary; this is deliberately a separate identifier.
 */
export interface WorkspaceEnvironment {
  id: string
  workspaceId: string
  kind: 'local' | 'ssh' | 'remote'
  label: string
}

/**
 * Main-owned gateway for hosted Ola resources. Tokens and access tickets are
 * intentionally absent from this contract and therefore cannot enter the
 * renderer, runtime journal, tool environment, or normal logs.
 */
export interface AccountGateway {
  openManagedModelRequest(input: {
    workspaceId: string
    resourceId: string
    sessionId: string
    endpoint: string
    body: Uint8Array
    contentType: 'application/json'
    signal: AbortSignal
  }): Promise<Response>
}

/** Local provider credentials are resolved only by a host implementation. */
export interface SecretStore {
  hasLocalModelSecret(source: Extract<ModelSource, { kind: 'local' }>): Promise<boolean>
}

/**
 * Browser ownership is a capability, not a renderer object. This is the
 * contract the future WebContentsView service will implement.
 */
export interface BrowserService {
  canUseBrowser(input: { workspaceId: string; environmentId: string }): Promise<boolean>
}

export interface RuntimeHost {
  listWorkspaceEnvironments(workspaceId: string): Promise<WorkspaceEnvironment[]>
  accountGateway?: AccountGateway
  secretStore: SecretStore
  browser: BrowserService
}
