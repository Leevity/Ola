import { app, safeStorage, shell } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from 'crypto'
import { setRemoteControlAllowed } from './authorization-state'
import { desktopMeshCapabilities, desktopMeshPlatform, loadDesktopMeshIdentity } from './mesh-node'

type RemoteAuthState = {
  apiBaseUrl: string
  token: string
  account: Record<string, unknown>
  device: Record<string, unknown> | null
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
  | 'model-config'
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
let pendingOAuthState: {
  apiBaseUrl: string
  state: string
  verifier: string
  createdAt: number
} | null = null

function vaultPath(): string {
  return join(app.getPath('userData'), 'remote-auth.bin')
}

function pendingOAuthPath(): string {
  return join(app.getPath('userData'), 'remote-oauth-pending.bin')
}

async function loadPendingOAuthState(): Promise<typeof pendingOAuthState> {
  if (pendingOAuthState) return pendingOAuthState
  if (!safeStorage.isEncryptionAvailable()) return null
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
  if (!safeStorage.isEncryptionAvailable()) return
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
  if (memoryState) return memoryState
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const encrypted = await readFile(vaultPath())
    memoryState = JSON.parse(safeStorage.decryptString(encrypted)) as RemoteAuthState
    return memoryState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function saveState(state: RemoteAuthState | null): Promise<void> {
  memoryState = state
  if (!safeStorage.isEncryptionAvailable()) return
  const target = vaultPath()
  const temporary = `${target}.${randomUUID()}.tmp`
  await mkdir(app.getPath('userData'), { recursive: true })
  const encrypted = safeStorage.encryptString(JSON.stringify(state))
  await writeFile(temporary, encrypted, { mode: 0o600 })
  await rename(temporary, target)
}

async function apiRequest<T>(
  baseUrl: string,
  path: string,
  body: Record<string, unknown> | undefined,
  token?: string
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  let result: Record<string, unknown> = {}
  if (text) {
    try {
      result = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new Error(
        `Remote API returned invalid JSON (${response.status}) at ${path}: ${text.slice(0, 180)}`
      )
    }
  }
  if (!response.ok)
    throw new Error(String(result.error || response.statusText || 'Remote API failed'))
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
  'model-config',
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
    'model-config': [],
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
  if (request.operation === 'model-config') {
    if (!state?.token) throw new Error('Login is required before syncing model configuration')
    return apiRequest(apiBaseUrl, '/api/account/model-config', {}, state.token)
  }
  if (request.operation === 'logout') {
    setRemoteControlAllowed(false)
    if (state?.token) {
      await apiRequest(apiBaseUrl, '/api/auth/logout', {}, state.token).catch(() => undefined)
    }
    await saveState(null)
    return { success: true }
  }
  if (request.operation === 'hydrate' && (!state?.token || state.apiBaseUrl !== apiBaseUrl)) {
    return { account: null, device: null }
  }
  if (!state?.token || state.apiBaseUrl !== apiBaseUrl) throw new Error('Remote login is required')

  if (request.operation === 'hydrate') {
    const result = await apiRequest<{ account: Record<string, unknown> }>(
      apiBaseUrl,
      '/api/auth/me',
      undefined,
      state.token
    )
    state.account = result.account
    await saveState(state)
    return { account: state.account, device: state.device }
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
      state.token
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
    return apiRequest(
      apiBaseUrl,
      '/api/mesh/v1/events',
      {
        ticket,
        eventId: eventID,
        subjectNodeId: subjectNodeID,
        targetNodeId: targetNodeID,
        sessionId: sessionID,
        sequence,
        type,
        payload: payload.payload
      },
      state.token
    )
  }
  if (request.operation === 'mesh-event-list') {
    const targetNodeID = requiredString(payload, 'targetNodeId')
    const after = payload.after == null ? 0 : payload.after
    if (!Number.isInteger(after) || Number(after) < 0) throw new Error('invalid event cursor')
    return apiRequest(
      apiBaseUrl,
      `/api/mesh/v1/events?targetNodeId=${encodeURIComponent(targetNodeID)}&after=${Number(after)}`,
      undefined,
      state.token
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
