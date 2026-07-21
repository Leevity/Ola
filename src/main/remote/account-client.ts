import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { setRemoteControlAllowed } from './authorization-state'

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
  | 'logout'
  | 'device-register'
  | 'device-list'
  | 'session-list'
  | 'device-heartbeat'
  | 'device-signaling-token'
  | 'pairing-create'
  | 'pairing-revoke'
  | 'pairing-resolve'

export type RemoteAccountRequest = {
  apiBaseUrl: string
  operation: RemoteAccountOperation
  payload?: Record<string, unknown>
}

let memoryState: RemoteAuthState | null = null

function vaultPath(): string {
  return join(app.getPath('userData'), 'remote-auth.bin')
}

function validateBaseUrl(value: string): string {
  const url = new URL(value)
  const local =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Remote API must use HTTPS except for localhost development')
  }
  return url.toString().replace(/\/$/, '')
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
  const result = text ? (JSON.parse(text) as Record<string, unknown>) : {}
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
  'logout',
  'device-register',
  'device-list',
  'session-list',
  'device-heartbeat',
  'device-signaling-token',
  'pairing-create',
  'pairing-revoke',
  'pairing-resolve'
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
    logout: [],
    'device-register': ['deviceName', 'platform', 'fingerprint'],
    'device-list': [],
    'session-list': [],
    'device-heartbeat': ['deviceId'],
    'device-signaling-token': ['deviceId'],
    'pairing-create': ['deviceId'],
    'pairing-revoke': ['deviceId'],
    'pairing-resolve': ['deviceId', 'code', 'sessionId']
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
  if (request.operation === 'device-list')
    return apiRequest(apiBaseUrl, '/api/devices', undefined, state.token)
  if (request.operation === 'session-list')
    return apiRequest(apiBaseUrl, '/api/sessions', undefined, state.token)
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
