import { canPersistSecrets } from '../credentials/secure-storage-policy'
import { publicWorkspaceDirectory, publicModelDirectory } from '../../shared/workspace-directory'
import { app, safeStorage, shell } from 'electron'
import { mkdir, readFile, rename, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from 'crypto'
import { setRemoteControlAllowed } from './authorization-state'
import { notifyRemoteAccountCleared, notifyWorkspaceDirectoryChanged } from './account-lifecycle'
import { desktopMeshCapabilities, desktopMeshPlatform, loadDesktopMeshIdentity } from './mesh-node'
import {
  cachedWorkspaceExpiresAt,
  cachedWorkspaceDirectory,
  isOfflineTransportError,
  type OfflineWorkspaceSnapshot
} from './offline-workspace-cache'
import type { WorkspaceSyncScope } from '../../shared/sync-types'

type RemoteAuthState = {
  apiBaseUrl: string
  token: string
  account: Record<string, unknown>
  device: Record<string, unknown> | null
  workspaceDirectoryCache?: OfflineWorkspaceSnapshot
}

export type RemoteAccountOperation =
  | 'hydrate'
  | 'register'
  | 'login'
  | 'oauth-start'
  | 'oauth-callback'
  | 'logout'
  | 'device-register'
  | 'device-list'
  | 'session-list'
  | 'device-heartbeat'
  | 'mesh-node-register'
  | 'mesh-node-list'
  | 'mesh-node-heartbeat'
  | 'mesh-capability-ticket'
  | 'mesh-event-publish'
  | 'mesh-event-list'
  | 'workspace-list'
  | 'workspace-model-resources'
  | 'device-signaling-token'
  | 'pairing-create'
  | 'pairing-revoke'
  | 'pairing-resolve'
  | 'pairing-auto-resolve'

export type RemoteAccountRequest = {
  apiBaseUrl: string
  operation: RemoteAccountOperation
  payload?: Record<string, unknown>
}

let memoryState: RemoteAuthState | null = null
let authStateLoaded = false
let authStateRevision = 0
let authStateWrite: Promise<void> = Promise.resolve()
let modelAuthorization = new AbortController()
let pendingOAuthState: {
  apiBaseUrl: string
  state: string
  verifier: string
  createdAt: number
} | null = null

const DEFAULT_REMOTE_ACCOUNT_API_BASE_URL = 'https://lbxai.cn'
const LEGACY_DEFAULT_REMOTE_ACCOUNT_API_BASE_URL = 'http://100.64.0.6:7300'
const MANAGED_MODEL_ENDPOINTS = new Set([
  'chat/completions',
  'responses',
  'images/generations',
  'images/edits',
  'audio/speech',
  'audio/transcriptions',
  'embeddings'
])

class RemoteApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

async function revokeCachedWorkspaceDirectoryOnDenial(
  state: RemoteAuthState,
  error: unknown
): Promise<void> {
  if (
    error instanceof RemoteApiError &&
    (error.status === 401 || error.status === 403) &&
    memoryState === state
  ) {
    if (state.workspaceDirectoryCache) {
      delete state.workspaceDirectoryCache
      await saveState(state, false)
    }
    await notifyWorkspaceDirectoryChanged(new Set())
  }
}

function migrateLegacyRemoteApiBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/$/, '') === LEGACY_DEFAULT_REMOTE_ACCOUNT_API_BASE_URL
    ? DEFAULT_REMOTE_ACCOUNT_API_BASE_URL
    : apiBaseUrl
}

function vaultPath(): string {
  return join(app.getPath('userData'), 'remote-auth.bin')
}

function pendingOAuthPath(): string {
  return join(app.getPath('userData'), 'remote-oauth-pending.bin')
}

async function loadPendingOAuthState(): Promise<typeof pendingOAuthState> {
  if (pendingOAuthState) return pendingOAuthState
  if (!canPersistSecrets(safeStorage)) return null
  try {
    const encrypted = await readFile(pendingOAuthPath())
    pendingOAuthState = JSON.parse(safeStorage.decryptString(encrypted))
    return pendingOAuthState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

async function savePendingOAuthState(state: typeof pendingOAuthState): Promise<void> {
  pendingOAuthState = state
  if (!state || !canPersistSecrets(safeStorage)) {
    await unlink(pendingOAuthPath()).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    return
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  const encrypted = safeStorage.encryptString(JSON.stringify(state))
  await writeFile(pendingOAuthPath(), encrypted, { mode: 0o600 })
}

function validateBaseUrl(value: string): string {
  const url = new URL(value)
  const local =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  const tailscaleDevHost =
    !app.isPackaged &&
    /^100\.(6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\.(?:\d{1,3})\.(?:\d{1,3})$/.test(url.hostname)
  if (url.username || url.password || url.hash || url.search)
    throw new Error('Invalid remote API URL')
  if (
    url.protocol !== 'https:' &&
    !(local && url.protocol === 'http:') &&
    !(tailscaleDevHost && url.protocol === 'http:')
  ) {
    throw new Error('Remote API must use HTTPS except for localhost development')
  }
  return url.toString().replace(/\/$/, '')
}

function oauthWebBaseUrl(apiBaseUrl: string): string {
  const apiUrl = new URL(apiBaseUrl)
  if (apiUrl.port === '7300') {
    apiUrl.port = '4310'
  }
  return apiUrl.toString().replace(/\/$/, '')
}

async function loadState(): Promise<RemoteAuthState | null> {
  if (authStateLoaded) return memoryState
  if (!canPersistSecrets(safeStorage)) return null
  try {
    const encrypted = await readFile(vaultPath())
    memoryState = JSON.parse(safeStorage.decryptString(encrypted)) as RemoteAuthState | null
    authStateLoaded = true
    if (!memoryState) return null
    const migratedApiBaseUrl = migrateLegacyRemoteApiBaseUrl(memoryState.apiBaseUrl)
    if (migratedApiBaseUrl !== memoryState.apiBaseUrl) {
      memoryState.apiBaseUrl = migratedApiBaseUrl
      await saveState(memoryState)
    }
    return memoryState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function saveState(
  state: RemoteAuthState | null,
  revokeModelAuthorization = true
): Promise<void> {
  const previousAccess = memoryState
  const accessChanged = Boolean(
    previousAccess?.token &&
    (!state ||
      previousAccess.token !== state.token ||
      previousAccess.apiBaseUrl !== state.apiBaseUrl)
  )
  if (revokeModelAuthorization) {
    modelAuthorization.abort()
    modelAuthorization = new AbortController()
  }
  memoryState = state
  authStateLoaded = true
  const revision = ++authStateRevision
  const write = authStateWrite
    .catch(() => undefined)
    .then(async () => {
      if (revision !== authStateRevision) return
      if (!state || !canPersistSecrets(safeStorage)) {
        await unlink(vaultPath()).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
        return
      }
      const target = vaultPath()
      const temporary = `${target}.${randomUUID()}.tmp`
      await mkdir(app.getPath('userData'), { recursive: true })
      const encrypted = safeStorage.encryptString(JSON.stringify(state))
      try {
        await writeFile(temporary, encrypted, { mode: 0o600 })
        if (revision === authStateRevision) await rename(temporary, target)
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
    })
  authStateWrite = write
  await write
  if (accessChanged) await notifyRemoteAccountCleared()
}

async function fetchWorkspaceDirectory(
  state: RemoteAuthState
): Promise<ReturnType<typeof publicWorkspaceDirectory>> {
  let directory: ReturnType<typeof publicWorkspaceDirectory>
  try {
    directory = publicWorkspaceDirectory(
      await apiRequest(
        validateBaseUrl(state.apiBaseUrl),
        '/api/account/workspaces',
        undefined,
        state.token,
        undefined,
        5_000
      )
    )
  } catch (error) {
    await revokeCachedWorkspaceDirectoryOnDenial(state, error)
    throw error
  }
  if (memoryState !== state) throw new Error('Ola account changed while loading workspaces')
  if (typeof state.account.id === 'string') {
    state.workspaceDirectoryCache = {
      accountId: state.account.id,
      apiBaseUrl: state.apiBaseUrl,
      fetchedAt: Date.now(),
      directory
    }
    await saveState(state, false)
  }
  return directory
}

async function offlineCapableWorkspaceDirectory(
  state: RemoteAuthState
): Promise<ReturnType<typeof publicWorkspaceDirectory> & { offline?: boolean }> {
  try {
    return await fetchWorkspaceDirectory(state)
  } catch (error) {
    if (!isOfflineTransportError(error)) throw error
    if (memoryState !== state) throw new Error('Ola account changed while loading workspaces')
    const cached = cachedWorkspaceDirectory(
      state.account.id,
      state.apiBaseUrl,
      state.workspaceDirectoryCache
    )
    if (!cached) throw error
    return { ...cached, offline: true }
  }
}

async function apiRequest<T>(
  baseUrl: string,
  path: string,
  body: Record<string, unknown> | undefined,
  token?: string,
  deviceToken?: string,
  timeoutMs = 30_000
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(deviceToken ? { 'x-ola-device-token': deviceToken } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await response.text()
  let result: Record<string, unknown> = {}
  if (text) {
    try {
      result = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new Error(`Remote API returned invalid JSON (${response.status}) at ${path}`)
    }
  }
  if (!response.ok)
    throw new RemoteApiError(
      String(result.error || response.statusText || 'Remote API failed'),
      response.status
    )
  return result as T
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new Error(`${key} is required`)
  }
  return value.trim()
}

const REMOTE_ACCOUNT_OPERATIONS = new Set<RemoteAccountOperation>([
  'hydrate',
  'register',
  'login',
  'oauth-start',
  'oauth-callback',
  'logout',
  'device-register',
  'device-list',
  'session-list',
  'device-heartbeat',
  'mesh-node-register',
  'mesh-node-list',
  'mesh-node-heartbeat',
  'mesh-capability-ticket',
  'mesh-event-publish',
  'mesh-event-list',
  'workspace-list',
  'workspace-model-resources',
  'device-signaling-token',
  'pairing-create',
  'pairing-revoke',
  'pairing-resolve',
  'pairing-auto-resolve'
])

function validateAccountRequest(request: RemoteAccountRequest): Record<string, unknown> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Invalid remote account request')
  }
  const unknownRequestKey = Object.keys(request).find(
    (key) => !['apiBaseUrl', 'operation', 'payload'].includes(key)
  )
  if (unknownRequestKey)
    throw new Error(`Unknown remote account request field: ${unknownRequestKey}`)
  if (
    typeof request.apiBaseUrl !== 'string' ||
    !request.apiBaseUrl ||
    request.apiBaseUrl.length > 2048
  ) {
    throw new Error('Invalid remote API URL')
  }
  if (!REMOTE_ACCOUNT_OPERATIONS.has(request.operation)) {
    throw new Error('Unsupported remote account operation')
  }
  if (
    request.payload != null &&
    (typeof request.payload !== 'object' || Array.isArray(request.payload))
  ) {
    throw new Error('Invalid remote account payload')
  }
  const payload = request.payload ?? {}
  const allowedByOperation: Record<RemoteAccountOperation, string[]> = {
    hydrate: [],
    register: ['email', 'password'],
    login: ['email', 'password'],
    'oauth-start': [],
    'oauth-callback': ['callbackUrl'],
    logout: [],
    'device-register': ['deviceName', 'platform', 'fingerprint'],
    'device-list': [],
    'session-list': [],
    'device-heartbeat': ['deviceId'],
    'mesh-node-register': ['deviceId'],
    'mesh-node-list': [],
    'mesh-node-heartbeat': ['nodeId'],
    'mesh-capability-ticket': ['subjectNodeId', 'targetNodeId', 'sessionId', 'capabilities'],
    'mesh-event-publish': [
      'ticket',
      'eventId',
      'subjectNodeId',
      'targetNodeId',
      'sessionId',
      'sequence',
      'type',
      'payload'
    ],
    'mesh-event-list': ['targetNodeId', 'after'],
    'workspace-list': [],
    'workspace-model-resources': ['workspaceId'],
    'device-signaling-token': ['deviceId'],
    'pairing-create': ['deviceId'],
    'pairing-revoke': ['deviceId'],
    'pairing-resolve': ['deviceId', 'code', 'sessionId'],
    'pairing-auto-resolve': ['controllerDeviceId', 'controlledDeviceId', 'sessionId']
  }
  const allowed = new Set(allowedByOperation[request.operation])
  const unknownPayloadKey = Object.keys(payload).find((key) => !allowed.has(key))
  if (unknownPayloadKey)
    throw new Error(`Unknown remote account payload field: ${unknownPayloadKey}`)
  return payload
}

export async function invokeRemoteAccount(request: RemoteAccountRequest): Promise<unknown> {
  const payload = validateAccountRequest(request)
  const apiBaseUrl = validateBaseUrl(request.apiBaseUrl)
  if (request.operation === 'oauth-start') {
    const state = randomUUID()
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    await savePendingOAuthState({ apiBaseUrl, state, verifier, createdAt: Date.now() })
    const authorizeUrl = new URL(`${oauthWebBaseUrl(apiBaseUrl)}/oauth/authorize`)
    authorizeUrl.searchParams.set('client_id', 'ola-desktop')
    authorizeUrl.searchParams.set('redirect_uri', 'ola://auth/callback')
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('code_challenge', challenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    await shell.openExternal(authorizeUrl.toString())
    return { started: true }
  }
  if (request.operation === 'oauth-callback') {
    const callbackUrl = requiredString(payload, 'callbackUrl')
    const callback = new URL(callbackUrl)
    const code = callback.searchParams.get('code')
    const state = callback.searchParams.get('state')
    const pending = await loadPendingOAuthState()
    if (!code || !state || !pending || pending.state !== state) {
      throw new Error('Invalid or expired Ola authorization callback')
    }
    if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
      await savePendingOAuthState(null)
      throw new Error('Ola authorization callback expired')
    }
    const result = await apiRequest<{ access_token: string; account: Record<string, unknown> }>(
      pending.apiBaseUrl,
      '/api/oauth/token',
      {
        grant_type: 'authorization_code',
        client_id: 'ola-desktop',
        code,
        redirect_uri: 'ola://auth/callback',
        code_verifier: pending.verifier
      }
    )
    await savePendingOAuthState(null)
    await saveState({
      apiBaseUrl,
      token: result.access_token,
      account: result.account,
      device: null
    })
    return { account: result.account, device: null }
  }
  if (request.operation === 'register' || request.operation === 'login') {
    setRemoteControlAllowed(false)
    const email = requiredString(payload, 'email')
    const password = requiredString(payload, 'password')
    const result = await apiRequest<{ token: string; account: Record<string, unknown> }>(
      apiBaseUrl,
      request.operation === 'register' ? '/api/auth/register' : '/api/auth/login',
      request.operation === 'register'
        ? { email, password, displayName: email }
        : { email, password }
    )
    await saveState({ apiBaseUrl, token: result.token, account: result.account, device: null })
    return { account: result.account, device: null }
  }

  const state = await loadState()
  if (request.operation === 'workspace-list') {
    if (!state?.token || state.apiBaseUrl !== apiBaseUrl)
      throw new Error('Login is required before loading Ola workspaces')
    const directory = await offlineCapableWorkspaceDirectory(state)
    await notifyWorkspaceDirectoryChanged(
      new Set(directory.workspaces.map((workspace) => workspace.id))
    )
    return directory
  }
  if (request.operation === 'workspace-model-resources') {
    if (!state?.token || state.apiBaseUrl !== apiBaseUrl)
      throw new Error('Login is required before loading Ola model resources')
    const workspaceId = requiredString(payload, 'workspaceId')
    return publicModelDirectory(
      await apiRequest(
        apiBaseUrl,
        `/api/account/workspaces/${encodeURIComponent(workspaceId)}/model-resources`,
        undefined,
        state.token
      )
    )
  }
  if (request.operation === 'logout') {
    setRemoteControlAllowed(false)
    await saveState(null)
    if (state?.token) {
      await apiRequest(apiBaseUrl, '/api/auth/logout', {}, state.token).catch(() => undefined)
    }
    return { success: true }
  }
  if (request.operation === 'hydrate' && (!state?.token || state.apiBaseUrl !== apiBaseUrl)) {
    return { account: null, device: null }
  }
  if (!state?.token || state.apiBaseUrl !== apiBaseUrl) throw new Error('Remote login is required')

  if (request.operation === 'hydrate') {
    try {
      const result = await apiRequest<{ account: Record<string, unknown> }>(
        apiBaseUrl,
        '/api/auth/me',
        undefined,
        state.token
      )
      state.account = result.account
      await saveState(state)
      return { account: state.account, device: state.device }
    } catch (error) {
      await revokeCachedWorkspaceDirectoryOnDenial(state, error)
      if (
        !isOfflineTransportError(error) ||
        memoryState !== state ||
        !cachedWorkspaceDirectory(state.account.id, state.apiBaseUrl, state.workspaceDirectoryCache)
      )
        throw error
      return { account: state.account, device: state.device, offline: true }
    }
  }
  if (request.operation === 'device-register') {
    setRemoteControlAllowed(false)
    const result = await apiRequest<{ device: Record<string, unknown> }>(
      apiBaseUrl,
      '/api/devices/register',
      payload,
      state.token
    )
    state.device = result.device
    await saveState(state)
    return result
  }
  if (request.operation === 'mesh-node-register') {
    const deviceID = requiredString(payload, 'deviceId')
    if (!state.device || state.device.id !== deviceID)
      throw new Error('Device registration is required')
    const identity = await loadDesktopMeshIdentity()
    const deviceToken = await apiRequest<{ token: string }>(
      apiBaseUrl,
      `/api/devices/${encodeURIComponent(deviceID)}/signaling-token`,
      {},
      state.token
    )
    const registration = {
      deviceId: deviceID,
      platform: desktopMeshPlatform(),
      runtime: 'ola-desktop',
      runtimeVersion: app.getVersion(),
      publicKey: identity.publicKey,
      capabilities: desktopMeshCapabilities()
    }
    const digest = createHash('sha256').update(JSON.stringify(registration)).digest()
    const proof = sign(
      null,
      digest,
      createPrivateKey({
        key: Buffer.from(identity.privateKey, 'base64url'),
        format: 'der',
        type: 'pkcs8'
      })
    ).toString('base64url')
    return apiRequest(
      apiBaseUrl,
      '/api/mesh/v1/nodes/register',
      { ...registration, proof },
      state.token,
      deviceToken.token
    )
  }
  if (request.operation === 'mesh-node-list') {
    return apiRequest(apiBaseUrl, '/api/mesh/v1/nodes', undefined, state.token)
  }
  if (request.operation === 'mesh-node-heartbeat') {
    const nodeID = requiredString(payload, 'nodeId')
    return apiRequest(apiBaseUrl, `/api/mesh/v1/nodes/${nodeID}/heartbeat`, {}, state.token)
  }
  if (request.operation === 'mesh-capability-ticket') {
    const subjectNodeID = requiredString(payload, 'subjectNodeId')
    const targetNodeID = requiredString(payload, 'targetNodeId')
    const sessionID = requiredString(payload, 'sessionId')
    const capabilities = payload.capabilities
    if (
      !Array.isArray(capabilities) ||
      capabilities.length === 0 ||
      capabilities.length > 16 ||
      capabilities.some((value) => typeof value !== 'string' || !value.trim())
    ) {
      throw new Error('capabilities are required')
    }
    return apiRequest(
      apiBaseUrl,
      '/api/mesh/v1/capability-tickets',
      {
        subjectNodeId: subjectNodeID,
        targetNodeId: targetNodeID,
        sessionId: sessionID,
        capabilities
      },
      state.token
    )
  }
  if (request.operation === 'mesh-event-publish') {
    const ticket = requiredString(payload, 'ticket')
    const eventID = requiredString(payload, 'eventId')
    const subjectNodeID = requiredString(payload, 'subjectNodeId')
    const targetNodeID = requiredString(payload, 'targetNodeId')
    const sessionID = requiredString(payload, 'sessionId')
    const type = requiredString(payload, 'type')
    const sequence = payload.sequence
    if (!Number.isInteger(sequence) || Number(sequence) <= 0 || Number(sequence) > 1_000_000) {
      throw new Error('sequence is required')
    }
    if (!payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) {
      throw new Error('event payload must be an object')
    }
    const identity = await loadDesktopMeshIdentity()
    const signedEvent = {
      eventId: eventID,
      subjectNodeId: subjectNodeID,
      targetNodeId: targetNodeID,
      sessionId: sessionID,
      sequence,
      type,
      payload: payload.payload
    }
    const payloadDigest = createHash('sha256').update(JSON.stringify(payload.payload)).digest('hex')
    const signingInput = [
      'v0alpha1',
      eventID,
      subjectNodeID,
      targetNodeID,
      sessionID,
      String(sequence),
      type,
      payloadDigest
    ].join('\n')
    const digest = createHash('sha256').update(signingInput).digest()
    const signature = sign(
      null,
      digest,
      createPrivateKey({
        key: Buffer.from(identity.privateKey, 'base64url'),
        format: 'der',
        type: 'pkcs8'
      })
    ).toString('base64url')
    return apiRequest(
      apiBaseUrl,
      '/api/mesh/v1/events',
      {
        ticket,
        ...signedEvent,
        signature
      },
      state.token
    )
  }
  if (request.operation === 'mesh-event-list') {
    const targetNodeID = requiredString(payload, 'targetNodeId')
    const after = payload.after == null ? 0 : payload.after
    if (!Number.isInteger(after) || Number(after) < 0) throw new Error('invalid event cursor')
    if (!state.device?.id || targetNodeID !== `node-${state.device.id}`) {
      throw new Error('Mesh events can only be read by their target device')
    }
    const deviceToken = await apiRequest<{ token: string }>(
      apiBaseUrl,
      `/api/devices/${encodeURIComponent(String(state.device.id))}/signaling-token`,
      {},
      state.token
    )
    return apiRequest(
      apiBaseUrl,
      `/api/mesh/v1/events?targetNodeId=${encodeURIComponent(targetNodeID)}&after=${Number(after)}`,
      undefined,
      state.token,
      deviceToken.token
    )
  }
  if (request.operation === 'device-list')
    return apiRequest(apiBaseUrl, '/api/devices', undefined, state.token)
  if (request.operation === 'session-list')
    return apiRequest(apiBaseUrl, '/api/sessions', undefined, state.token)
  if (request.operation === 'pairing-auto-resolve') {
    const result = await apiRequest(
      apiBaseUrl,
      '/api/pairing/auto-resolve',
      {
        controllerDeviceId: requiredString(payload, 'controllerDeviceId'),
        controlledDeviceId: requiredString(payload, 'controlledDeviceId'),
        sessionId: requiredString(payload, 'sessionId')
      },
      state.token
    )
    setRemoteControlAllowed(true)
    return result
  }
  const deviceID = requiredString(payload, 'deviceId')
  if (request.operation === 'device-heartbeat') {
    return apiRequest(apiBaseUrl, `/api/devices/${deviceID}/heartbeat`, {}, state.token)
  }
  if (request.operation === 'device-signaling-token') {
    return apiRequest(apiBaseUrl, `/api/devices/${deviceID}/signaling-token`, {}, state.token)
  }
  if (request.operation === 'pairing-create') {
    const result = await apiRequest(
      apiBaseUrl,
      '/api/pairing/create',
      { deviceId: deviceID },
      state.token
    )
    setRemoteControlAllowed(true)
    return result
  }
  if (request.operation === 'pairing-revoke') {
    setRemoteControlAllowed(false)
    return apiRequest(apiBaseUrl, '/api/pairing/revoke', { deviceId: deviceID }, state.token)
  }
  if (request.operation === 'pairing-resolve') {
    return apiRequest(
      apiBaseUrl,
      '/api/pairing/resolve',
      {
        code: requiredString(payload, 'code'),
        controllerDeviceId: deviceID,
        sessionId: requiredString(payload, 'sessionId')
      },
      state.token
    )
  }
  throw new Error('Unsupported remote account operation')
}

export async function handleRemoteOAuthCallback(callbackUrl: string): Promise<unknown> {
  if (!pendingOAuthState) throw new Error('No pending Ola authorization request')
  return invokeRemoteAccount({
    apiBaseUrl: pendingOAuthState.apiBaseUrl,
    operation: 'oauth-callback',
    payload: { callbackUrl }
  })
}

// This is deliberately main-only: account tokens and model tickets never cross IPC.
export async function openManagedModelRequest(input: {
  workspaceId: string
  resourceId: string
  sessionId: string
  endpoint: string
  body: Uint8Array
  contentType: string
  signal: AbortSignal
}): Promise<Response> {
  // This function is the last capability boundary before a short-lived
  // account ticket is attached. Do not rely on a renderer or future
  // TS runtime adapter to have already constrained the endpoint or payload.
  if (!MANAGED_MODEL_ENDPOINTS.has(input.endpoint))
    throw new Error('Unsupported Ola model endpoint')
  if (input.body.byteLength > 32 * 1024 * 1024)
    throw new Error('Ola model request exceeds the size limit')
  const state = await loadState()
  if (!state?.token || !state.device?.id)
    throw new Error('Sign in to Ola and register this device, or select a local model.')
  const baseUrl = validateBaseUrl(state.apiBaseUrl)
  const signal = AbortSignal.any([
    input.signal,
    modelAuthorization.signal,
    AbortSignal.timeout(10 * 60_000)
  ])
  const ticketResponse = await fetch(`${baseUrl}/api/account/model-access-ticket`, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      resourceId: input.resourceId,
      sessionId: input.sessionId,
      deviceId: state.device.id
    })
  })
  if (!ticketResponse.ok)
    throw new Error(
      `Ola model authorization unavailable (${ticketResponse.status}). Refresh your workspace or select a local model.`
    )
  const ticket = (await ticketResponse.json()) as { ticket?: unknown }
  if (typeof ticket.ticket !== 'string' || !ticket.ticket || ticket.ticket.length > 16384)
    throw new Error('Ola returned an invalid model ticket')
  signal.throwIfAborted()
  const response = await fetch(`${baseUrl}/v1/${input.endpoint}`, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { 'content-type': input.contentType, authorization: `Bearer ${ticket.ticket}` },
    body: Buffer.from(input.body)
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      `Ola model unavailable (${response.status}). Refresh your workspace or select a local model.`
    )
  }
  return response
}

/** Main-only public metadata lookup; it never returns account credentials or tickets. */
export async function loadManagedModelResources(workspaceId: string): Promise<unknown[]> {
  if (!workspaceId || workspaceId.length > 1024) throw new Error('Invalid Ola workspace')
  const state = await loadState()
  if (!state?.token) throw new Error('Sign in to Ola and select a local model.')
  const directory = publicModelDirectory(
    await apiRequest(
      validateBaseUrl(state.apiBaseUrl),
      `/api/account/workspaces/${encodeURIComponent(workspaceId)}/model-resources`,
      undefined,
      state.token
    )
  )
  return directory.resources
}

/** Main-only workspace authorization directory for runtime hosts. */
export async function loadManagedWorkspaceIds(): Promise<Set<string>> {
  const state = await loadState()
  if (!state?.token) return new Set()
  const directory = await fetchWorkspaceDirectory(state)
  return new Set(directory.workspaces.map((workspace) => workspace.id))
}

/** Resolve the authenticated, offline-capable identity used by v2 workspace sync. */
export async function loadWorkspaceSyncScope(workspaceId: string): Promise<WorkspaceSyncScope> {
  if (!workspaceId || workspaceId.length > 1024) throw new Error('Invalid Ola workspace')
  const state = await loadState()
  if (!state?.token || typeof state.account.id !== 'string' || !state.account.id)
    throw new Error('Remote login is required for workspace sync')
  if (workspaceId === 'local-personal') {
    return { accountId: state.account.id, apiBaseUrl: state.apiBaseUrl, workspaceId }
  }
  const directory = await offlineCapableWorkspaceDirectory(state)
  if (!directory.workspaces.some((workspace) => workspace.id === workspaceId))
    throw new Error('SYNC_WORKSPACE_UNAVAILABLE')
  return { accountId: state.account.id, apiBaseUrl: state.apiBaseUrl, workspaceId }
}

/** Local-only workspace data may use a recent encrypted, account-bound directory while offline. */
export async function loadOfflineWorkspaceIds(): Promise<Set<string>> {
  const state = await loadState()
  if (!state?.token) return new Set()
  const directory = await offlineCapableWorkspaceDirectory(state)
  const ids = new Set(directory.workspaces.map((workspace) => workspace.id))
  await notifyWorkspaceDirectoryChanged(ids)
  return ids
}

/** Main-only timestamp for proactively expiring offline team authorization. */
export async function loadOfflineWorkspaceExpiresAt(): Promise<number | null> {
  const state = await loadState()
  if (!state?.token) return null
  return cachedWorkspaceExpiresAt(state.account.id, state.apiBaseUrl, state.workspaceDirectoryCache)
}
