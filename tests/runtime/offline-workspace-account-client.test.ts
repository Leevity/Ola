import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'

const electronState = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) =>
      name === 'sessionData'
        ? path.join(electronState.userData, 'session-data')
        : electronState.userData,
    getVersion: () => '1.0.0-test',
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  shell: { openExternal: async () => undefined }
}))

let userData: string

beforeAll(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'ola-offline-workspaces-'))
  electronState.userData = userData
  await mkdir(path.join(userData, 'session-data'))
  await writeFile(
    path.join(userData, 'session-data', 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: 'test-key' } })
  )
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await rm(userData, { recursive: true, force: true })
})

function createSignedMobileReceipt(): {
  event: Record<string, unknown>
  mobilePublicKey: string
  controlPlanePublicKey: string
} {
  const mobile = generateKeyPairSync('ed25519')
  const controlPlane = generateKeyPairSync('ed25519')
  const nowSeconds = Math.floor(Date.now() / 1000)
  const claims = {
    purpose: 'mesh-capability',
    protocolVersion: 'v0alpha1',
    ticketId: 'ticket-receipt-01',
    accountId: 'account-a',
    subjectNodeId: 'node-mobile-a',
    targetNodeId: 'node-desktop-a',
    sessionId: 'session-receipt-01',
    capabilities: ['mesh.event.receive'],
    nonce: 'receipt-nonce-01',
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 300
  }
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const ticketSignature = sign(null, Buffer.from(encodedClaims), controlPlane.privateKey).toString(
    'base64url'
  )
  const payload = {
    task_id: 'task-receipt-01',
    task_state: 'completed',
    result_text: 'Mobile task completed safely.'
  }
  const canonicalPayload = JSON.stringify(
    Object.fromEntries(
      Object.keys(payload)
        .sort()
        .map((key) => [key, payload[key as keyof typeof payload]])
    )
  )
  const payloadDigest = createHash('sha256').update(canonicalPayload).digest('hex')
  const digest = createHash('sha256')
    .update(
      [
        'v0alpha2',
        'receipt-event-01',
        claims.subjectNodeId,
        claims.targetNodeId,
        claims.sessionId,
        '1',
        'task.completed',
        payloadDigest
      ].join('\n')
    )
    .digest()
  const publicKeyText = mobile.publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64url')
  const controlPlanePublicKey = controlPlane.publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64url')
  return {
    event: {
      cursor: 1,
      protocolVersion: 'v0alpha2',
      eventId: 'receipt-event-01',
      subjectNodeId: claims.subjectNodeId,
      targetNodeId: claims.targetNodeId,
      sessionId: claims.sessionId,
      sequence: 1,
      type: 'task.completed',
      payload,
      capabilities: claims.capabilities,
      signature: sign(null, digest, mobile.privateKey).toString('base64url'),
      ticket: `${encodedClaims}.${ticketSignature}`
    },
    mobilePublicKey: publicKeyText,
    controlPlanePublicKey
  }
}

describe('main account-bound offline workspace directory', () => {
  it('uses cached local metadata only for transport failures and clears it on logout', async () => {
    let accountClient = await import('../../src/main/remote/account-client')
    const base = 'https://account.example.test'
    let mode: 'online' | 'offline' | 'denied' | 'forbidden' = 'online'
    vi.stubGlobal('fetch', async (url: string) => {
      if (mode === 'offline') throw new TypeError('network unavailable')
      if (mode === 'denied')
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      if (mode === 'forbidden')
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
      if (url.endsWith('/api/auth/login'))
        return Response.json({ token: 'test-token', account: { id: 'account-a' } })
      if (url.endsWith('/api/account/workspaces'))
        return Response.json({
          workspaces: [{ id: 'team-a', kind: 'team', name: 'Team A' }]
        })
      return Response.json({ success: true })
    })

    await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'login',
      payload: { email: 'a@example.test', password: 'secret' }
    })
    expect(await accountClient.loadManagedWorkspaceIds()).toEqual(new Set(['team-a']))

    vi.resetModules()
    accountClient = await import('../../src/main/remote/account-client')
    const { onWorkspaceDirectoryChanged } = await import('../../src/main/remote/account-lifecycle')
    const directories: string[][] = []
    const unsubscribe = onWorkspaceDirectoryChanged((ids) => {
      directories.push([...ids])
    })
    mode = 'offline'
    expect(await accountClient.loadOfflineWorkspaceIds()).toEqual(new Set(['team-a']))
    await expect(accountClient.loadManagedWorkspaceIds()).rejects.toThrow('network unavailable')
    expect(
      await accountClient.invokeRemoteAccount({ apiBaseUrl: base, operation: 'hydrate' })
    ).toMatchObject({ account: { id: 'account-a' }, offline: true })

    mode = 'denied'
    await expect(accountClient.loadOfflineWorkspaceIds()).rejects.toThrow('Unauthorized')
    expect(directories.at(-1)).toEqual([])
    expect(await accountClient.loadOfflineWorkspaceExpiresAt()).toBeNull()
    await expect(
      accountClient.invokeRemoteAccount({ apiBaseUrl: base, operation: 'hydrate' })
    ).rejects.toThrow('Unauthorized')

    mode = 'forbidden'
    await expect(accountClient.loadOfflineWorkspaceIds()).rejects.toThrow('Forbidden')
    expect(directories.at(-1)).toEqual([])

    mode = 'offline'
    await expect(accountClient.loadOfflineWorkspaceIds()).rejects.toThrow('network unavailable')

    await accountClient.invokeRemoteAccount({ apiBaseUrl: base, operation: 'logout' })
    expect(await accountClient.loadOfflineWorkspaceIds()).toEqual(new Set())
    unsubscribe()
  })

  it('revokes remote-control consent before ending the account session', async () => {
    vi.resetModules()
    const accountClient = await import('../../src/main/remote/account-client')
    const authorization = await import('../../src/main/remote/authorization-state')
    const base = 'https://account.example.test'
    const paths: string[] = []
    expect(authorization.isRemoteControlAllowed()).toBe(false)
    vi.stubGlobal('fetch', async (url: string) => {
      const pathname = new URL(url).pathname
      paths.push(pathname)
      if (pathname === '/api/auth/login') {
        return Response.json({ token: 'test-token', account: { id: 'account-a' } })
      }
      if (pathname === '/api/devices/register') {
        return Response.json({ device: { id: 'device-a', accountId: 'account-a' } })
      }
      if (pathname === '/api/pairing/create') {
        return Response.json({
          code: '123456',
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        })
      }
      return Response.json({ success: true })
    })

    await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'login',
      payload: { email: 'a@example.test', password: 'secret' }
    })
    await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'device-register',
      payload: { deviceName: 'Desktop', platform: 'macOS', fingerprint: 'fingerprint-a' }
    })
    await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'pairing-create',
      payload: { deviceId: 'device-a' }
    })
    expect(authorization.isRemoteControlAllowed()).toBe(true)
    await accountClient.invokeRemoteAccount({ apiBaseUrl: base, operation: 'logout' })

    expect(authorization.isRemoteControlAllowed()).toBe(false)
    expect(paths.indexOf('/api/pairing/revoke')).toBeGreaterThanOrEqual(0)
    expect(paths.indexOf('/api/pairing/revoke')).toBeLessThan(paths.indexOf('/api/auth/logout'))
  })

  it('publishes desktop Mesh tasks with an Ed25519 signature verifiable by mobile nodes', async () => {
    vi.resetModules()
    const accountClient = await import('../../src/main/remote/account-client')
    const base = 'https://account.example.test'
    let publicKeyText = ''
    const publishedEvents: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
      const pathname = new URL(url).pathname
      if (pathname === '/api/auth/login') {
        return Response.json({ token: 'test-token', account: { id: 'account-a' } })
      }
      if (pathname === '/api/devices/register') {
        return Response.json({ device: { id: 'desktop-a', accountId: 'account-a' } })
      }
      if (pathname === '/api/devices/desktop-a/signaling-token') {
        return Response.json({ token: 'device-token' })
      }
      if (pathname === '/api/mesh/v1/nodes/register') {
        const body = JSON.parse(String(options?.body)) as { publicKey: string }
        publicKeyText = body.publicKey
        return Response.json({ node: { nodeId: 'node-desktop-a' } })
      }
      if (pathname === '/api/mesh/v1/capability-tickets') {
        return Response.json({ ticket: 'ticket-a', expiresIn: 300 })
      }
      if (pathname === '/api/mesh/v1/events' && options?.method === 'POST') {
        publishedEvents.push(JSON.parse(String(options.body)) as Record<string, unknown>)
        return Response.json({ event: { cursor: 1 } })
      }
      return Response.json({ error: `unexpected request: ${pathname}` }, { status: 404 })
    })

    await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'login',
      payload: { email: 'a@example.test', password: 'secret' }
    })
    await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'device-register',
      payload: { deviceName: 'Desktop', platform: 'macOS', fingerprint: 'desktop-fingerprint' }
    })
    await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'mesh-node-register',
      payload: { deviceId: 'desktop-a' }
    })
    const ticket = await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'mesh-capability-ticket',
      payload: {
        subjectNodeId: 'node-desktop-a',
        targetNodeId: 'node-mobile-golden',
        sessionId: 'session-golden-01',
        capabilities: ['task.execute']
      }
    })
    expect(ticket).toMatchObject({ ticket: 'ticket-a' })
    await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'mesh-event-publish',
      payload: {
        ticket: 'ticket-a',
        eventId: 'ola-mesh-golden-01',
        subjectNodeId: 'node-desktop-a',
        targetNodeId: 'node-mobile-golden',
        sessionId: 'session-golden-01',
        sequence: 1,
        type: 'task.requested',
        payload: { task_id: 'task-golden-01', task_text: 'Summarize <this> & café safely.' }
      }
    })

    expect(publicKeyText).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(publishedEvents).toHaveLength(1)
    const event = publishedEvents[0]
    expect(event).toMatchObject({
      protocolVersion: 'v0alpha2',
      eventId: 'ola-mesh-golden-01',
      subjectNodeId: 'node-desktop-a',
      targetNodeId: 'node-mobile-golden',
      sessionId: 'session-golden-01',
      sequence: 1,
      type: 'task.requested',
      payload: { task_id: 'task-golden-01', task_text: 'Summarize <this> & café safely.' }
    })
    const payload = event.payload as Record<string, string>
    const canonicalPayload = JSON.stringify(
      Object.fromEntries(
        Object.keys(payload)
          .sort()
          .map((key) => [key, payload[key]])
      )
    )
    expect(canonicalPayload).toBe(
      '{"task_id":"task-golden-01","task_text":"Summarize <this> & café safely."}'
    )
    const payloadDigest = createHash('sha256').update(canonicalPayload).digest('hex')
    expect(payloadDigest).toBe('0d37fb802f67d2a8e16b654eed5bfbaa716bda669d005a1114fe4ca3bfd1116a')
    const signingInput = [
      event.protocolVersion,
      event.eventId,
      event.subjectNodeId,
      event.targetNodeId,
      event.sessionId,
      String(event.sequence),
      event.type,
      payloadDigest
    ].join('\n')
    const digest = createHash('sha256').update(signingInput).digest()
    const rawPublicKey = Buffer.from(publicKeyText, 'base64url')
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPublicKey]),
      format: 'der',
      type: 'spki'
    })
    expect(verify(null, digest, publicKey, Buffer.from(String(event.signature), 'base64url'))).toBe(
      true
    )
  })

  it('verifies server-delivered Mesh receipts before returning them to the renderer', async () => {
    vi.resetModules()
    const accountClient = await import('../../src/main/remote/account-client')
    const base = 'https://account.example.test'
    const receipt = createSignedMobileReceipt()
    let tamperReceipt = false
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/api/auth/login') {
        return Response.json({ token: 'test-token', account: { id: 'account-a' } })
      }
      if (parsed.pathname === '/api/devices/register') {
        return Response.json({ device: { id: 'desktop-a', accountId: 'account-a' } })
      }
      if (parsed.pathname === '/api/devices/desktop-a/signaling-token') {
        return Response.json({ token: 'device-token' })
      }
      if (parsed.pathname === '/api/mesh/v1/nodes/register') {
        return Response.json({ node: { nodeId: 'node-desktop-a' } })
      }
      if (parsed.pathname === '/api/mesh/v1/events' && options?.method !== 'POST') {
        const event = structuredClone(receipt.event)
        if (tamperReceipt) event.signature = 'invalid-signature'
        return Response.json({ events: [event] })
      }
      if (parsed.pathname === '/api/mesh/v1/nodes') {
        return Response.json({
          nodes: [
            {
              nodeId: 'node-mobile-a',
              platform: 'android',
              publicKey: receipt.mobilePublicKey
            }
          ]
        })
      }
      if (parsed.pathname === '/api/mesh/v1/control-plane-key') {
        return Response.json({ publicKey: receipt.controlPlanePublicKey })
      }
      return Response.json({ error: `unexpected request: ${parsed.pathname}` }, { status: 404 })
    })

    await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'login',
      payload: { email: 'a@example.test', password: 'secret' }
    })
    await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'device-register',
      payload: { deviceName: 'Desktop', platform: 'macOS', fingerprint: 'desktop-fingerprint' }
    })
    const request = {
      apiBaseUrl: base,
      operation: 'mesh-event-list' as const,
      payload: { targetNodeId: 'node-desktop-a', after: 0 }
    }
    await accountClient.invokeRemoteAccount({
      apiBaseUrl: base,
      operation: 'mesh-node-register',
      payload: { deviceId: 'desktop-a' }
    })

    const valid = (await accountClient.invokeRemoteAccount(request)) as {
      events: Array<{ type: string; payload: { task_id: string } }>
      nextCursor: number
    }
    expect(valid.events).toMatchObject([
      { type: 'task.completed', payload: { task_id: 'task-receipt-01' } }
    ])
    expect(valid.nextCursor).toBe(1)

    tamperReceipt = true
    const invalid = (await accountClient.invokeRemoteAccount(request)) as {
      events: unknown[]
      nextCursor: number
    }
    expect(invalid.events).toEqual([])
    expect(invalid.nextCursor).toBe(1)
  })
})
