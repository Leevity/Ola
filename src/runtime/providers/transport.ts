import { RuntimeError, type RunSpec } from '../../shared/runtime/contracts'
import type { AccountGateway } from '../../shared/runtime/host'
import type { ModelOptions, ModelProtocol } from '../../shared/runtime/model'
import { openResponsesWebSocket, ResponsesWebSocketPool } from './responses-websocket'

export interface ModelTarget {
  protocol: ModelProtocol
  model: string
  options?: ModelOptions
  /** Main-owned, non-secret Responses WebSocket routing metadata. */
  websocketUrl?: string
  websocketMode?: 'auto' | 'disabled'
  responsesSessionScope?: string
}
export interface ModelRequest {
  endpoint: string
  body: Record<string, unknown>
}
export interface ModelTransport {
  resolve: (run: RunSpec) => Promise<ModelTarget>
  request: (
    run: RunSpec,
    target: ModelTarget,
    request: ModelRequest,
    signal: AbortSignal
  ) => Promise<Response>
}
export interface LocalModelTarget extends ModelTarget {
  baseUrl: string
  apiKey?: string
  bearerToken?: string
  headers?: Record<string, string>
  builtinId?: string
}

export type { AccountGateway } from '../../shared/runtime/host'

export interface ManagedModelTarget extends ModelTarget {
  workspaceId: string
  resourceId: string
}

export function applyBodyOptions(
  body: Record<string, unknown>,
  options: ModelOptions = {}
): Record<string, unknown> {
  const result = { ...body, ...options.bodyOverrides }
  for (const key of options.omitBodyKeys ?? []) delete result[key]
  return result
}

function effectiveOptions(target: ModelTarget, run: RunSpec): ModelOptions | undefined {
  const options = { ...target.options, ...run.modelOptions }
  return Object.keys(options).length ? options : undefined
}

/** Credentials are resolved again per request; never cached on run records or sent to a codec. */
export class LocalModelTransport implements ModelTransport {
  private readonly responsesWebSocketPool = new ResponsesWebSocketPool()

  constructor(
    private resolvePrivate: (run: RunSpec) => Promise<LocalModelTarget>,
    private fetcher: typeof fetch = fetch
  ) {}
  async resolve(run: RunSpec): Promise<ModelTarget> {
    if (run.modelSource.kind !== 'local') throw new RuntimeError('ACCOUNT_GATEWAY_REQUIRED')
    const resolved = await this.resolvePrivate(run)
    const { protocol, model, options } = resolved
    const effective = effectiveOptions({ protocol, model, options }, run)
    const responsesSessionScope = resolved.responsesSessionScope ?? effective?.responsesSessionScope
    return {
      protocol,
      model,
      ...(effective ? { options: effective } : {}),
      ...(resolved.websocketUrl ? { websocketUrl: resolved.websocketUrl } : {}),
      ...(resolved.websocketMode ? { websocketMode: resolved.websocketMode } : {}),
      ...(responsesSessionScope ? { responsesSessionScope } : {})
    }
  }
  async request(
    run: RunSpec,
    expected: ModelTarget,
    request: ModelRequest,
    signal: AbortSignal
  ): Promise<Response> {
    if (run.modelSource.kind !== 'local') throw new RuntimeError('ACCOUNT_GATEWAY_REQUIRED')
    const target = await this.resolvePrivate(run)
    signal.throwIfAborted()
    if (target.protocol !== expected.protocol || target.model !== expected.model)
      throw new RuntimeError('MODEL_BINDING_CHANGED')
    const effective = effectiveOptions(target, run)
    const responsesSessionScope = target.responsesSessionScope ?? effective?.responsesSessionScope
    let base = target.baseUrl.trim().replace(/\/+$/, '')
    if (target.protocol === 'anthropic') base = base.replace(/\/v1(?:\/messages)?$/, '')
    if (target.protocol === 'gemini') base = base.replace(/\/openai$/, '')
    if (target.protocol === 'vertex-ai' && !base.endsWith('/publishers/google'))
      base += '/publishers/google'
    const url = new URL(`${base}/${request.endpoint}`)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.hostname === 'ola.invalid'
    )
      throw new RuntimeError('INVALID_PROVIDER_URL')
    const headers = new Headers({ 'content-type': 'application/json' })
    if (target.protocol === 'anthropic') {
      if (target.apiKey) headers.set('x-api-key', target.apiKey)
      if (target.builtinId === 'longcat' && target.apiKey)
        headers.set('authorization', `Bearer ${target.apiKey}`)
      headers.set('anthropic-version', '2023-06-01')
      headers.set(
        'anthropic-beta',
        target.options?.cacheTtl === '1h'
          ? 'prompt-caching-2024-07-31,interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11'
          : 'prompt-caching-2024-07-31,interleaved-thinking-2025-05-14'
      )
    } else if (target.protocol === 'gemini' || target.protocol === 'vertex-ai') {
      if (target.apiKey) headers.set('x-goog-api-key', target.apiKey)
    } else if (target.apiKey) headers.set('authorization', `Bearer ${target.apiKey}`)
    if (target.bearerToken) headers.set('authorization', `Bearer ${target.bearerToken}`)
    for (const [key, value] of Object.entries(target.headers ?? {}))
      headers.set(
        key,
        value
          .replace(/\{\{\s*sessionId\s*\}\}/g, run.sessionId)
          .replace(/\{\{\s*model\s*\}\}/g, target.model)
      )
    if (
      target.protocol === 'openai-responses' &&
      target.websocketMode !== 'disabled' &&
      target.websocketUrl
    ) {
      if (responsesSessionScope) {
        return await this.responsesWebSocketPool.open({
          key: `${run.workspaceId}\u0000${run.sessionId}\u0000${responsesSessionScope}\u0000${target.websocketUrl}\u0000${target.model}\u0000${headers.get('authorization') ?? ''}`,
          url: target.websocketUrl,
          headers,
          body: request.body,
          signal
        })
      }
      return await openResponsesWebSocket({
        url: target.websocketUrl,
        headers,
        body: request.body,
        signal
      })
    }
    let response: Response
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers,
        redirect: 'error',
        signal,
        body: JSON.stringify(request.body)
      })
    } catch {
      signal.throwIfAborted()
      throw new RuntimeError('PROVIDER_CONNECTION_FAILED')
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new RuntimeError(
        response.status === 401 || response.status === 403
          ? 'PROVIDER_AUTH_REQUIRED'
          : response.status === 429
            ? 'PROVIDER_RATE_LIMITED'
            : 'PROVIDER_REQUEST_FAILED'
      )
    }
    return response
  }
}

const MANAGED_PROTOCOLS = new Set<ModelTarget['protocol']>(['openai-chat', 'openai-responses'])

/**
 * Managed resources are an account-gateway capability, not a local provider.
 * The resolver is intentionally called for every turn so revocation or a
 * changed directory cannot be bypassed by an earlier public catalog snapshot.
 */
export class AccountGatewayTransport implements ModelTransport {
  constructor(
    private readonly resolvePublic: (run: RunSpec) => Promise<ManagedModelTarget>,
    private readonly gateway: AccountGateway
  ) {}
  async resolve(run: RunSpec): Promise<ModelTarget> {
    if (run.modelSource.kind === 'local') throw new RuntimeError('MANAGED_MODEL_REQUIRED')
    const target = await this.resolvePublic(run)
    if (
      target.workspaceId !== run.workspaceId ||
      target.workspaceId !== run.modelSource.workspaceId ||
      target.resourceId !== run.modelSource.resourceId ||
      !MANAGED_PROTOCOLS.has(target.protocol)
    )
      throw new RuntimeError('MODEL_UNAVAILABLE')
    const options = effectiveOptions(target, run)
    return {
      protocol: target.protocol,
      model: target.model,
      ...(options ? { options } : {})
    }
  }
  async request(
    run: RunSpec,
    expected: ModelTarget,
    request: ModelRequest,
    signal: AbortSignal
  ): Promise<Response> {
    if (run.modelSource.kind === 'local') throw new RuntimeError('MANAGED_MODEL_REQUIRED')
    const target = await this.resolvePublic(run)
    signal.throwIfAborted()
    if (
      target.workspaceId !== run.workspaceId ||
      target.workspaceId !== run.modelSource.workspaceId ||
      target.resourceId !== run.modelSource.resourceId ||
      target.protocol !== expected.protocol ||
      target.model !== expected.model ||
      !MANAGED_PROTOCOLS.has(target.protocol) ||
      !['chat/completions', 'responses'].includes(request.endpoint)
    )
      throw new RuntimeError('MODEL_BINDING_CHANGED')
    const body = new TextEncoder().encode(JSON.stringify(request.body))
    if (body.byteLength > 32 * 1024 * 1024) throw new RuntimeError('MODEL_REQUEST_TOO_LARGE')
    try {
      const response = await this.gateway.openManagedModelRequest({
        workspaceId: target.workspaceId,
        resourceId: target.resourceId,
        sessionId: run.sessionId,
        endpoint: request.endpoint,
        body,
        contentType: 'application/json',
        signal
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new RuntimeError(
          response.status === 401 || response.status === 403
            ? 'MODEL_UNAVAILABLE'
            : response.status === 429
              ? 'PROVIDER_RATE_LIMITED'
              : 'PROVIDER_REQUEST_FAILED'
        )
      }
      return response
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof RuntimeError) throw error
      throw new RuntimeError('MODEL_UNAVAILABLE')
    }
  }
}
