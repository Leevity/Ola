/* eslint-disable @typescript-eslint/explicit-function-return-type */

const apiBase = process.env.OLA_REMOTE_SMOKE_API ?? 'http://127.0.0.1:17300'
const signalBase = process.env.OLA_REMOTE_SMOKE_SIGNAL ?? 'ws://127.0.0.1:17301/ws/signaling'

async function request(path, body, token) {
  const response = await fetch(`${apiBase}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(result)}`)
  return result
}

async function createIdentity(label) {
  const suffix = `${Date.now()}-${Math.random()}`
  const auth = await request('/api/auth/register', {
    email: `${label}-${suffix}@example.com`,
    password: 'smoke-test-password',
    displayName: label
  })
  const registered = await request(
    '/api/devices/register',
    { deviceName: label, platform: 'smoke', fingerprint: suffix },
    auth.token
  )
  const signaling = await request(
    `/api/devices/${registered.device.id}/signaling-token`,
    {},
    auth.token
  )
  return { token: auth.token, device: registered.device, signalingToken: signaling.token }
}

function waitFor(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for WebSocket ${event}`)),
      timeoutMs
    )
    socket.addEventListener(
      event,
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      { once: true }
    )
  })
}

async function waitForAudit(token, sessionId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await request('/api/sessions', undefined, token)
    const audit = result.sessions?.find((item) => item.sessionId === sessionId)
    if (audit?.endedAt && audit.transport === 'turn' && audit.bytesTransferred === 4096) {
      return audit
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for session audit ${sessionId}`)
}

async function connectSignal(token) {
  const url = new URL(signalBase)
  const socket = new WebSocket(url, ['ola-remote-v1', `ola-token.${token}`])
  await waitFor(socket, 'open')
  return socket
}

const controlled = await createIdentity('controlled')
const controller = await createIdentity('controller')
const pairing = await request(
  '/api/pairing/create',
  { deviceId: controlled.device.id },
  controlled.token
)
const sessionId = crypto.randomUUID()
const resolved = await request(
  '/api/pairing/resolve',
  { code: pairing.code, controllerDeviceId: controller.device.id, sessionId },
  controller.token
)

const controlledSocket = await connectSignal(controlled.signalingToken)
const controllerSocket = await connectSignal(controller.signalingToken)
const receivedOffer = waitFor(controlledSocket, 'message')
controllerSocket.send(
  JSON.stringify({
    type: 'offer',
    to: controlled.device.id,
    sessionId,
    authorization: resolved.sessionTicket,
    payload: { description: { type: 'offer', sdp: 'smoke-test' } }
  })
)
const offerEvent = await receivedOffer
const offer = JSON.parse(String(offerEvent.data))
if (offer.from !== controller.device.id || offer.authorization) {
  throw new Error(`Unexpected forwarded offer: ${JSON.stringify(offer)}`)
}

controllerSocket.send(
  JSON.stringify({
    type: 'stats',
    to: controlled.device.id,
    sessionId,
    payload: { transport: 'turn', bytesTransferred: 4096 }
  })
)

const controlledClosed = waitFor(controlledSocket, 'close')
const controllerClosed = waitFor(controllerSocket, 'close')
await request('/api/pairing/revoke', { deviceId: controlled.device.id }, controlled.token)
await Promise.all([controlledClosed, controllerClosed])
const audit = await waitForAudit(controller.token, sessionId)
const controlledAudits = await request('/api/sessions', undefined, controlled.token)
if (controlledAudits.sessions?.some((item) => item.sessionId === sessionId)) {
  throw new Error('Session audit leaked into the controlled device account')
}
if (audit.disconnectReason !== 'device_revoked') {
  throw new Error(`Unexpected disconnect reason: ${audit.disconnectReason}`)
}

console.log(
  JSON.stringify({
    api: true,
    deviceTokens: true,
    pairing: true,
    authorizedOffer: true,
    authorizationStripped: true,
    revokeClosedBothPeers: true,
    statsAudited: true,
    auditAccountScoped: true
  })
)
