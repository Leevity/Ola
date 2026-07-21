import {
  createRemoteConnection,
  deleteRemoteConnection,
  getRemoteConnection,
  listRemoteConnections,
  updateRemoteConnection
} from '../remote/connection-store'
import { remoteControlEngine } from '../remote/engine'
import { detectRdpClient } from '../remote/rdp/rdp-detector'
import { detectVncClient } from '../remote/vnc/vnc-detector'
import type {
  RemoteConnectInput,
  RemoteConnection,
  RemoteConnectionListResult,
  RemoteConnectionUpdateRequest,
  RemoteSession,
  RemoteViewerCredential
} from '../../shared/remote-control'
import { registerMessagePackHandler } from './messagepack-handler'
import { dispatchRemoteInput, setRemoteInputSession } from '../remote/input-controller'
import type { RemoteInputEnvelope } from '../../shared/remote-control'
import { invokeRemoteAccount, type RemoteAccountRequest } from '../remote/account-client'
import { deleteCredential, getCredentialRef, storeCredential } from '../credentials/secret-vault'
import type { RemoteConnectionCreateRequest } from '../../shared/remote-control'
import { desktopCapturer, screen, systemPreferences } from 'electron'
import { testRemoteEndpoint } from '../remote/connection-tester'
import type { RemoteConnectionTestResult } from '../../shared/remote-control'
import { setRemoteControlAllowed } from '../remote/authorization-state'

function validateRemoteCredentialRef(id: string | null | undefined): void {
  if (id && !getCredentialRef(id))
    throw new Error('Remote credential was not found in Credential Vault')
}

function requireExactObject(
  value: unknown,
  keys: string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}`)
  const allowed = new Set(keys)
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`Unknown ${label} field: ${unknown}`)
  return value as Record<string, unknown>
}

async function createConnectionWithCredential(
  request: RemoteConnectionCreateRequest
): Promise<RemoteConnection> {
  if (!request || typeof request !== 'object') throw new Error('Invalid remote connection request')
  const allowedKeys = new Set([
    'kind',
    'groupId',
    'name',
    'host',
    'port',
    'username',
    'credentialRef',
    'tags',
    'rdp',
    'vnc',
    'olaDevice',
    'password'
  ])
  const unknownKey = Object.keys(request).find((key) => !allowedKeys.has(key))
  if (unknownKey) throw new Error(`Unknown remote connection request field: ${unknownKey}`)
  const { password, ...input } = request
  if (password != null && (typeof password !== 'string' || password.length > 4096)) {
    throw new Error('Remote password is invalid')
  }
  if (password && input.credentialRef) {
    throw new Error('Provide either a new password or an existing credential reference')
  }
  let createdCredentialId: string | null = null
  if (password) {
    if (input.kind !== 'rdp' && input.kind !== 'vnc') {
      throw new Error('Passwords are supported only for RDP and VNC connections')
    }
    const host = typeof input.host === 'string' ? input.host.trim() : ''
    if (!host) throw new Error('Host is required before storing a remote credential')
    const port = input.port ?? (input.kind === 'rdp' ? 3389 : 5900)
    const ref = storeCredential({
      domain: `remote://${input.kind}/${host}:${port}`,
      username: typeof input.username === 'string' ? input.username.trim() : '',
      password,
      source: 'manual',
      notes: 'Managed by Ola Remote Control'
    })
    input.credentialRef = ref.id
    createdCredentialId = ref.id
  } else {
    validateRemoteCredentialRef(input.credentialRef)
  }
  try {
    return await createRemoteConnection(input)
  } catch (error) {
    if (createdCredentialId) deleteCredential(createdCredentialId)
    throw error
  }
}

export function closeAllRemoteSessions(): void {
  setRemoteControlAllowed(false)
  setRemoteInputSession(null)
  remoteControlEngine.sessions.disconnectAll()
}

export function registerRemoteHandlers(): void {
  registerMessagePackHandler<undefined, RemoteConnectionListResult>('remote:connection:list', () =>
    listRemoteConnections()
  )

  registerMessagePackHandler<RemoteConnectionCreateRequest, RemoteConnection>(
    'remote:connection:create',
    (args) => createConnectionWithCredential(args)
  )

  registerMessagePackHandler<RemoteConnectionUpdateRequest, RemoteConnection>(
    'remote:connection:update',
    (args) => {
      const value = requireExactObject(
        args,
        ['id', 'patch', 'password'],
        'remote connection update request'
      )
      if (typeof value.id !== 'string' || !value.id || value.id.length > 128) {
        throw new Error('Invalid remote connection ID')
      }
      if (!value.patch || typeof value.patch !== 'object' || Array.isArray(value.patch)) {
        throw new Error('Invalid remote connection patch')
      }
      const patch = value.patch as RemoteConnectionUpdateRequest['patch']
      validateRemoteCredentialRef(patch.credentialRef)
      const password = value.password
      if (password != null && (typeof password !== 'string' || password.length > 4096)) {
        throw new Error('Remote password is invalid')
      }
      if (!password) return updateRemoteConnection({ id: value.id, patch })

      return (async () => {
        const existing = await getRemoteConnection(value.id as string)
        if (!existing || (existing.kind !== 'rdp' && existing.kind !== 'vnc')) {
          throw new Error('Remote connection not found')
        }
        const host = typeof patch.host === 'string' ? patch.host.trim() : existing.host
        const port = patch.port ?? existing.port ?? (existing.kind === 'rdp' ? 3389 : 5900)
        if (!host) throw new Error('Host is required before storing a remote credential')
        const ref = storeCredential({
          domain: `remote://${existing.kind}/${host}:${port}`,
          username:
            typeof patch.username === 'string' ? patch.username.trim() : (existing.username ?? ''),
          password,
          source: 'manual',
          notes: 'Managed by Ola Remote Control'
        })
        try {
          const updated = await updateRemoteConnection({
            id: existing.id,
            patch: { ...patch, credentialRef: ref.id }
          })
          if (existing.credentialRef && existing.credentialRef !== ref.id) {
            deleteCredential(existing.credentialRef)
          }
          return updated
        } catch (error) {
          deleteCredential(ref.id)
          throw error
        }
      })()
    }
  )

  registerMessagePackHandler<{ id: string }, RemoteConnectionTestResult>(
    'remote:connection:test',
    async (args) => {
      const value = requireExactObject(args, ['id'], 'remote connection test request')
      if (typeof value.id !== 'string' || !value.id || value.id.length > 128) {
        throw new Error('Invalid remote connection ID')
      }
      const connection = await getRemoteConnection(value.id)
      if (!connection) throw new Error('Remote connection not found')
      if ((connection.kind !== 'rdp' && connection.kind !== 'vnc') || !connection.host) {
        throw new Error('Only RDP and VNC endpoints can be tested')
      }
      return testRemoteEndpoint(
        connection.host,
        connection.port ?? (connection.kind === 'rdp' ? 3389 : 5900)
      )
    }
  )

  registerMessagePackHandler<{ id: string }, { success: true }>(
    'remote:connection:delete',
    async (args) => {
      const value = requireExactObject(args, ['id'], 'remote connection delete request')
      if (typeof value.id !== 'string' || !value.id || value.id.length > 128) {
        throw new Error('Invalid remote connection ID')
      }
      const connection = await getRemoteConnection(value.id)
      const result = await deleteRemoteConnection(value.id)
      if (connection?.credentialRef) deleteCredential(connection.credentialRef)
      return result
    }
  )

  registerMessagePackHandler<undefined, { sessions: RemoteSession[] }>(
    'remote:session:list',
    () => ({
      sessions: remoteControlEngine.sessions.list()
    })
  )

  registerMessagePackHandler<{ sessionId: string }, RemoteViewerCredential | null>(
    'remote:session:credential',
    (args) => {
      const value = requireExactObject(args, ['sessionId'], 'remote session credential request')
      if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 128) {
        throw new Error('Invalid remote session ID')
      }
      return remoteControlEngine.getViewerCredential(value.sessionId)
    }
  )

  registerMessagePackHandler<RemoteConnectInput, RemoteSession>('remote:connect', (args) => {
    const value = requireExactObject(args, ['connectionId'], 'remote connect request')
    if (
      typeof value.connectionId !== 'string' ||
      !value.connectionId ||
      value.connectionId.length > 128
    ) {
      throw new Error('Invalid remote connection ID')
    }
    return remoteControlEngine.connect(value.connectionId)
  })

  registerMessagePackHandler<{ sessionId: string }, { session: RemoteSession | null }>(
    'remote:disconnect',
    (args) => {
      const value = requireExactObject(args, ['sessionId'], 'remote disconnect request')
      if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 128) {
        throw new Error('Invalid remote session ID')
      }
      return { session: remoteControlEngine.disconnect(value.sessionId) }
    }
  )

  registerMessagePackHandler<undefined, Awaited<ReturnType<typeof detectRdpClient>>>(
    'remote:rdp:detect',
    () => detectRdpClient()
  )

  registerMessagePackHandler<undefined, Awaited<ReturnType<typeof detectVncClient>>>(
    'remote:vnc:detect',
    () => detectVncClient()
  )

  registerMessagePackHandler<
    { sessionId: string | null; displayId?: string | null },
    { success: true }
  >('remote:input:set-session', (args) => {
    const value = requireExactObject(
      args,
      ['sessionId', 'displayId'],
      'remote input session request'
    )
    if (value.sessionId !== null && typeof value.sessionId !== 'string') {
      throw new Error('Invalid remote input session ID')
    }
    if (
      value.displayId != null &&
      (typeof value.displayId !== 'string' || value.displayId.length > 64)
    ) {
      throw new Error('Invalid remote capture display ID')
    }
    setRemoteInputSession(
      value.sessionId as string | null,
      (value.displayId as string | null) ?? null
    )
    return { success: true }
  })

  registerMessagePackHandler<
    RemoteInputEnvelope,
    { success: true } | { success: false; error: string }
  >('remote:input:dispatch', (args) => dispatchRemoteInput(args))

  registerMessagePackHandler<RemoteAccountRequest, unknown>('remote:account:invoke', (args) =>
    invokeRemoteAccount(args)
  )

  registerMessagePackHandler<undefined, { status: string }>('remote:capture:permission', () => ({
    status:
      process.platform === 'darwin'
        ? systemPreferences.getMediaAccessStatus('screen')
        : 'not-applicable'
  }))

  registerMessagePackHandler<
    undefined,
    { sources: Array<{ id: string; name: string; displayId: string; primary: boolean }> }
  >('remote:capture:sources', async () => {
    const primaryDisplayId = String(screen.getPrimaryDisplay().id)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    })
    return {
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        displayId: source.display_id,
        primary: source.display_id === primaryDisplayId
      }))
    }
  })
}
