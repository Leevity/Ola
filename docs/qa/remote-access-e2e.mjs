// End-to-end probe for the Ola remote-control loop against a live Ola-admin.
// Covers: three-state permission lifecycle, console->PC signaling routing,
// permission revocation mid-session, server-side hang up, the audit trail, and
// the Mesh task round-trip (phone dispatches to a desktop, desktop receipts back).
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto'

const API = process.env.OLA_API || 'http://127.0.0.1:7300'
const SIGNAL = process.env.OLA_SIGNAL || 'ws://127.0.0.1:7301/ws/signaling'

const results = []
let token = ''
let pc = null // controlled device (the PC)
let consoleDev = null // controller device (the web console)
let pcDeviceToken = ''
let consoleDeviceToken = ''

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}

function check(name, condition, detail) {
  record(name, Boolean(condition), detail)
  return Boolean(condition)
}

async function api(method, path, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, body: json, code: json && json.code }
}

function openSocket(deviceToken) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SIGNAL, ['ola-remote-v1', `ola-token.${deviceToken}`])
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', () => reject(new Error('signaling handshake failed')))
  })
}

function collect(ws) {
  const inbox = []
  ws.addEventListener('message', (event) => {
    try {
      inbox.push(JSON.parse(String(event.data)))
    } catch {
      /* ignore */
    }
  })
  return inbox
}

async function waitFor(inbox, predicate, label, timeout = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const hit = inbox.find(predicate)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function settle(ms = 250) {
  await new Promise((r) => setTimeout(r, ms))
}

const MESH_PROTOCOL = 'v0alpha2'

function meshIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  // SPKI wraps the raw key in a fixed 12-byte header; the relay wants the 32 bytes.
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  return { publicKey: raw.toString('base64url'), privateKey }
}

// v0alpha2 signs canonical compact JSON with sorted keys and no HTML escaping,
// so a payload survives PostgreSQL jsonb storage without changing its signature.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(text) {
  return createHash('sha256').update(text).digest()
}

function registerMeshNode(deviceId, deviceToken, identity, platform, capabilities) {
  const fields = {
    deviceId,
    platform,
    runtime: 'ola-e2e',
    runtimeVersion: '1.0.6',
    publicKey: identity.publicKey,
    capabilities
  }
  // The registration proof is Go's json.Marshal of a struct, which keeps
  // declaration order rather than sorting keys. Sorting here would not verify.
  const proof = signBytes(null, sha256(JSON.stringify(fields)), identity.privateKey)
  return api(
    'POST',
    '/api/mesh/v1/nodes/register',
    { ...fields, proof: proof.toString('base64url') },
    { 'X-Ola-Device-Token': deviceToken }
  )
}

function meshTicket(subjectNodeId, targetNodeId, sessionId, capabilities) {
  return api('POST', '/api/mesh/v1/capability-tickets', {
    subjectNodeId,
    targetNodeId,
    sessionId,
    capabilities
  })
}

function meshSignature(identity, event) {
  const digest = sha256(
    [
      MESH_PROTOCOL,
      event.eventId,
      event.subjectNodeId,
      event.targetNodeId,
      event.sessionId,
      String(event.sequence),
      event.type,
      sha256(canonicalJson(event.payload)).toString('hex')
    ].join('\n')
  )
  return signBytes(null, digest, identity.privateKey).toString('base64url')
}

function publishMeshEvent(identity, event) {
  return api('POST', '/api/mesh/v1/events', {
    protocolVersion: MESH_PROTOCOL,
    ...event,
    signature: meshSignature(identity, event)
  })
}

function listMeshEvents(targetNodeId, deviceToken, after = 0) {
  return api('GET', `/api/mesh/v1/events?targetNodeId=${targetNodeId}&after=${after}`, null, {
    'X-Ola-Device-Token': deviceToken
  })
}

async function main() {
  // --- 1. account + devices -------------------------------------------------
  const login = await api('POST', '/api/auth/login', {
    email: 'admin@ola.test',
    password: 'OlaAdmin123!',
    clientId: 'ola-web'
  })
  if (
    !check('account login', login.status === 200 && login.body?.token, `status=${login.status}`)
  ) {
    throw new Error('cannot continue without an account session')
  }
  token = login.body.token

  const pcReg = await api('POST', '/api/devices/register', {
    deviceName: 'Ola-PC-E2E',
    platform: 'macos',
    fingerprint: 'fp-e2e-pc'
  })
  pc = pcReg.body?.device
  if (
    !check(
      'register controlled device (PC)',
      pcReg.status === 200 && pc?.id,
      `status=${pcReg.status}`
    )
  ) {
    throw new Error('cannot continue without a controlled device')
  }
  const conReg = await api('POST', '/api/devices/register', {
    deviceName: 'Ola Web Console',
    platform: 'web',
    fingerprint: 'fp-e2e-console'
  })
  consoleDev = conReg.body?.device
  check('register controller device (console)', conReg.status === 200 && consoleDev?.id)

  pcDeviceToken = (await api('POST', `/api/devices/${pc.id}/signaling-token`, {})).body?.token
  consoleDeviceToken = (await api('POST', `/api/devices/${consoleDev.id}/signaling-token`, {})).body
    ?.token
  check('issue device tokens for both peers', Boolean(pcDeviceToken && consoleDeviceToken))

  // --- 2. permission lifecycle ---------------------------------------------
  const initial = await api('GET', `/api/devices/${pc.id}/remote-access`)
  check(
    'new device defaults to mode=none',
    initial.status === 200 && initial.body?.remoteAccessMode === 'none',
    `mode=${initial.body?.remoteAccessMode}`
  )

  const blockedPairNone = await api('POST', '/api/pairing/create', { deviceId: pc.id })
  check(
    'console cannot open a pairing while the device is none',
    blockedPairNone.status === 403 && blockedPairNone.code === 'remote_access_disabled',
    `status=${blockedPairNone.status} code=${blockedPairNone.code}`
  )

  const noConfirm = await api('PUT', `/api/devices/${pc.id}/remote-access`, { mode: 'unattended' })
  check(
    'unattended requires typing the device name',
    noConfirm.status === 400 && noConfirm.code === 'confirmation_required',
    `status=${noConfirm.status} code=${noConfirm.code}`
  )

  const badMode = await api('PUT', `/api/devices/${pc.id}/remote-access`, { mode: 'godmode' })
  check(
    'unknown mode is rejected',
    badMode.status === 400 && badMode.code === 'invalid_access_mode',
    `status=${badMode.status} code=${badMode.code}`
  )

  const attended = await api('PUT', `/api/devices/${pc.id}/remote-access`, { mode: 'attended' })
  check(
    'account can switch the device to attended',
    attended.status === 200 && attended.body?.remoteAccessMode === 'attended',
    `mode=${attended.body?.remoteAccessMode}`
  )

  const reportAttended = await api(
    'POST',
    `/api/devices/${pc.id}/auto-approvals`,
    {
      sessionId: 'session-e2e',
      runId: 'run-e2e',
      toolName: 'shell.exec',
      decision: 'approved'
    },
    { 'X-Ola-Device-Token': pcDeviceToken }
  )
  check(
    'attended device may not report auto-approvals',
    reportAttended.status === 403 && reportAttended.code === 'auto_approval_requires_unattended',
    `status=${reportAttended.status} code=${reportAttended.code}`
  )

  const unattended = await api('PUT', `/api/devices/${pc.id}/remote-access`, {
    mode: 'unattended',
    confirm: 'Ola-PC-E2E'
  })
  check(
    'unattended accepts a confirmed switch',
    unattended.status === 200 &&
      unattended.body?.remoteAccessMode === 'unattended' &&
      unattended.body?.autoApprove === true,
    `mode=${unattended.body?.remoteAccessMode} autoApprove=${unattended.body?.autoApprove}`
  )

  const reportUnattended = await api(
    'POST',
    `/api/devices/${pc.id}/auto-approvals`,
    {
      sessionId: 'session-e2e',
      runId: 'run-e2e',
      toolName: 'shell.exec',
      decision: 'approved'
    },
    { 'X-Ola-Device-Token': pcDeviceToken }
  )
  check(
    'unattended device can report an auto-approval',
    reportUnattended.status === 200 && reportUnattended.body?.success === true,
    `status=${reportUnattended.status}`
  )

  // --- 3. console -> PC signaling loop -------------------------------------
  const consoleSocket = await openSocket(consoleDeviceToken)
  const pcSocket = await openSocket(pcDeviceToken)
  const consoleInbox = collect(consoleSocket)
  const pcInbox = collect(pcSocket)
  check(
    'both peers hold a signaling socket',
    consoleSocket.readyState === 1 && pcSocket.readyState === 1
  )

  const pairing = await api('POST', '/api/pairing/create', { deviceId: pc.id })
  check(
    'unattended device yields a pairing code to the console',
    pairing.status === 200 && Boolean(pairing.body?.code)
  )

  const sessionId = `session-e2e-${Date.now()}`
  const resolved = await api('POST', '/api/pairing/resolve', {
    code: pairing.body.code,
    controllerDeviceId: consoleDev.id,
    sessionId
  })
  check(
    'resolve returns a session ticket and the unattended flag',
    resolved.status === 200 &&
      Boolean(resolved.body?.sessionTicket) &&
      resolved.body?.remoteAccessMode === 'unattended' &&
      resolved.body?.autoApprove === true,
    `status=${resolved.status} mode=${resolved.body?.remoteAccessMode} autoApprove=${resolved.body?.autoApprove}`
  )

  consoleSocket.send(
    JSON.stringify({
      type: 'offer',
      to: pc.id,
      sessionId,
      authorization: resolved.body.sessionTicket,
      payload: {
        description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' },
        iceServers: []
      }
    })
  )
  let offerRelayed = false
  let offerError = ''
  try {
    const offer = await waitFor(pcInbox, (m) => m.type === 'offer', 'offer on the PC socket')
    offerRelayed =
      offer.from === consoleDev.id &&
      offer.sessionId === sessionId &&
      offer.payload?.description?.type === 'offer'
    check('PC receives the console offer through the hub', offerRelayed, `from=${offer.from}`)
  } catch (error) {
    offerError = pcInbox.find((m) => m.type === 'error')?.payload?.message || error.message
    check('PC receives the console offer through the hub', false, offerError)
  }

  pcSocket.send(
    JSON.stringify({
      type: 'answer',
      to: consoleDev.id,
      sessionId,
      payload: { description: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n' } }
    })
  )
  const answer = await waitFor(
    consoleInbox,
    (m) => m.type === 'answer',
    'answer on the console socket'
  )
  check('console receives the PC answer', answer.from === pc.id && answer.sessionId === sessionId)

  consoleSocket.send(
    JSON.stringify({
      type: 'candidate',
      to: pc.id,
      sessionId,
      payload: { candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host' } }
    })
  )
  const candidate = await waitFor(
    pcInbox,
    (m) => m.type === 'candidate',
    'ICE candidate on the PC socket'
  )
  check('ICE candidates relay in both directions', Boolean(candidate.payload?.candidate?.candidate))

  const statsRes = await api('POST', `/api/sessions/${sessionId}/end`, {})
  check(
    'console hang-up ends a live session',
    statsRes.status === 200 && statsRes.body?.live === true,
    `live=${statsRes.body?.live}`
  )
  const pcClose = await waitFor(
    pcInbox,
    (m) => m.type === 'close' && m.sessionId === sessionId,
    'close frame on the PC'
  )
  const consoleClose = await waitFor(
    consoleInbox,
    (m) => m.type === 'close' && m.sessionId === sessionId,
    'close frame on the console'
  )
  check(
    'both peers are told the session ended',
    pcClose.payload?.label === 'ended_by_controller' &&
      consoleClose.payload?.label === 'ended_by_controller',
    `label=${pcClose.payload?.label}`
  )

  // --- 3b. attended round: the lease must be armed by createPairing --------
  const toAttended = await api('PUT', `/api/devices/${pc.id}/remote-access`, { mode: 'attended' })
  check('device can be put back into attended', toAttended.body?.remoteAccessMode === 'attended')
  const attendedPair = await api('POST', '/api/pairing/create', { deviceId: pc.id })
  check(
    'attended device yields a pairing code',
    attendedPair.status === 200 && Boolean(attendedPair.body?.code)
  )
  const attendedSession = `session-e2e-${Date.now()}-attended`
  const attendedResolved = await api('POST', '/api/pairing/resolve', {
    code: attendedPair.body.code,
    controllerDeviceId: consoleDev.id,
    sessionId: attendedSession
  })
  check(
    'attended resolve returns a ticket with autoApprove=false',
    attendedResolved.status === 200 &&
      Boolean(attendedResolved.body?.sessionTicket) &&
      attendedResolved.body?.remoteAccessMode === 'attended' &&
      attendedResolved.body?.autoApprove === false,
    `status=${attendedResolved.status} mode=${attendedResolved.body?.remoteAccessMode} autoApprove=${attendedResolved.body?.autoApprove}`
  )
  consoleSocket.send(
    JSON.stringify({
      type: 'offer',
      to: pc.id,
      sessionId: attendedSession,
      authorization: attendedResolved.body.sessionTicket,
      payload: { description: { type: 'offer', sdp: 'v=0\r\n' }, iceServers: [] }
    })
  )
  let attendedOffer = null
  try {
    attendedOffer = await waitFor(
      pcInbox,
      (m) => m.type === 'offer' && m.sessionId === attendedSession,
      'attended offer'
    )
  } catch {
    /* handled below */
  }
  check('attended session reaches the PC', Boolean(attendedOffer))
  await api('POST', `/api/sessions/${attendedSession}/end`, {})

  // --- 4. revoking permission mid-session ----------------------------------
  const secondPair = await api('POST', '/api/pairing/create', { deviceId: pc.id })
  // The device is attended again, so resolve still works; the revoke below is
  // what has to tear the session down.
  const secondSession = `session-e2e-${Date.now()}-revoke`
  const secondResolved = await api('POST', '/api/pairing/resolve', {
    code: secondPair.body.code,
    controllerDeviceId: consoleDev.id,
    sessionId: secondSession
  })
  check('attended resolve primes the lease for the revocation test', secondResolved.status === 200)
  consoleSocket.send(
    JSON.stringify({
      type: 'offer',
      to: pc.id,
      sessionId: secondSession,
      authorization: secondResolved.body.sessionTicket,
      payload: { description: { type: 'offer', sdp: 'v=0\r\n' }, iceServers: [] }
    })
  )
  await waitFor(pcInbox, (m) => m.type === 'offer' && m.sessionId === secondSession, 'second offer')
  const revoke = await api('PUT', `/api/devices/${pc.id}/remote-access`, { mode: 'none' })
  check(
    'console can revoke access mid-session',
    revoke.status === 200 && revoke.body?.remoteAccessMode === 'none'
  )
  consoleSocket.send(
    JSON.stringify({
      type: 'candidate',
      to: pc.id,
      sessionId: secondSession,
      payload: { candidate: { candidate: 'candidate:2 1 udp 1 127.0.0.1 5001 typ host' } }
    })
  )
  const revocationError = await waitFor(
    consoleInbox,
    (m) => m.type === 'error' && /not allowing remote control/.test(m.payload?.message || ''),
    'revocation error frame'
  )
  check(
    'a revoked device drops the session on the next frame',
    /not allowing remote control/.test(revocationError.payload.message),
    revocationError.payload.message
  )

  // --- 5. audit trail ------------------------------------------------------
  await settle(400)
  const audit = await api('GET', '/api/control/audit')
  const events = audit.body?.events || []
  const actions = events.map((e) => e.action || e.Action)
  check('audit records the permission change', actions.includes('device.remote_access.changed'))
  check('audit records the auto-approval', actions.includes('device.auto_approval'))
  check('audit records the hang up', actions.includes('remote_session.ended'))
  const changed = events
    .filter((e) => (e.action || e.Action) === 'device.remote_access.changed')
    .map((e) => e.metadata || e.Metadata)
  check(
    'audit keeps the from/to transition',
    changed.some((m) => m && m.from === 'none' && m.to === 'attended') &&
      changed.some((m) => m && m.from === 'attended' && m.to === 'unattended') &&
      changed.some((m) => m && m.from === 'attended' && m.to === 'none'),
    JSON.stringify(changed).slice(0, 160)
  )

  // --- 6. Mesh task round-trip: phone dispatches, desktop receipts -----------
  // The desktop is now a task target, so the relay has to carry task.requested
  // towards a macos node and carry the receipt back under a different capability.
  const pcNodeId = `node-${pc.id}`
  const phoneNodeId = `node-${consoleDev.id}`
  const pcIdentity = meshIdentity()
  const phoneIdentity = meshIdentity()
  const pcNode = await registerMeshNode(pc.id, pcDeviceToken, pcIdentity, 'macos', [
    { id: 'mesh.event.receive', risk: 'low', version: '1' },
    { id: 'task.execute', risk: 'high', version: '1' }
  ])
  check(
    'desktop registers a node advertising task.execute',
    pcNode.status === 200 && pcNode.body?.node?.nodeId === pcNodeId,
    `status=${pcNode.status}`
  )
  const phoneNode = await registerMeshNode(
    consoleDev.id,
    consoleDeviceToken,
    phoneIdentity,
    'ios',
    [{ id: 'mesh.event.receive', risk: 'low', version: '1' }]
  )
  check(
    'phone registers a receipt-only node',
    phoneNode.status === 200,
    `status=${phoneNode.status}`
  )

  const meshSession = `session-mesh-${Date.now()}`
  const dispatchTicket = await meshTicket(phoneNodeId, pcNodeId, meshSession, ['task.execute'])
  check(
    'phone obtains a task.execute ticket for the desktop',
    dispatchTicket.status === 200 && Boolean(dispatchTicket.body?.ticket),
    `status=${dispatchTicket.status}`
  )
  const wrongDirection = await meshTicket(pcNodeId, phoneNodeId, meshSession, ['task.execute'])
  check(
    'a node that does not advertise task.execute cannot be targeted with it',
    wrongDirection.status === 403,
    `status=${wrongDirection.status} code=${wrongDirection.code}`
  )

  const taskId = `task-e2e-${Date.now()}`
  const taskText = '列出 ~/Desktop 的文件并总结 <大小> & 数量'
  const dispatch = await publishMeshEvent(phoneIdentity, {
    ticket: dispatchTicket.body?.ticket,
    eventId: `event-${taskId}`,
    subjectNodeId: phoneNodeId,
    targetNodeId: pcNodeId,
    sessionId: meshSession,
    sequence: 1,
    type: 'task.requested',
    payload: { task_id: taskId, task_text: taskText }
  })
  check(
    'relay accepts a signed task.requested',
    dispatch.status === 202,
    `status=${dispatch.status}`
  )

  const pcEvents = await listMeshEvents(pcNodeId, pcDeviceToken)
  const delivered = (pcEvents.body?.events || []).find((e) => e.eventId === `event-${taskId}`)
  check(
    'desktop receives the dispatch with its text intact',
    delivered?.payload?.task_text === taskText,
    JSON.stringify(delivered?.payload || null).slice(0, 120)
  )
  check(
    'the delivery ticket carries task.execute',
    Array.isArray(delivered?.capabilities) && delivered.capabilities.includes('task.execute'),
    JSON.stringify(delivered?.capabilities || null)
  )
  const anonymousList = await api('GET', `/api/mesh/v1/events?targetNodeId=${pcNodeId}&after=0`)
  check(
    'listing a node inbox requires that device’s token',
    anonymousList.status === 403,
    `status=${anonymousList.status}`
  )

  const emptyText = await publishMeshEvent(phoneIdentity, {
    ticket: dispatchTicket.body?.ticket,
    eventId: `event-${taskId}-empty`,
    subjectNodeId: phoneNodeId,
    targetNodeId: pcNodeId,
    sessionId: meshSession,
    sequence: 2,
    type: 'task.requested',
    payload: { task_id: `${taskId}-empty`, task_text: '   ' }
  })
  check(
    'a dispatch with blank task text is refused',
    emptyText.status === 400,
    `status=${emptyText.status}`
  )

  const oversized = await publishMeshEvent(phoneIdentity, {
    ticket: dispatchTicket.body?.ticket,
    eventId: `event-${taskId}-big`,
    subjectNodeId: phoneNodeId,
    targetNodeId: pcNodeId,
    sessionId: meshSession,
    sequence: 3,
    type: 'task.requested',
    payload: { task_id: `${taskId}-big`, task_text: 'x'.repeat(13 * 1024) }
  })
  check('task text above 12 KiB is refused', oversized.status === 400, `status=${oversized.status}`)

  const tamperedEvent = {
    ticket: dispatchTicket.body?.ticket,
    eventId: `event-${taskId}-tamper`,
    subjectNodeId: phoneNodeId,
    targetNodeId: pcNodeId,
    sessionId: meshSession,
    sequence: 4,
    type: 'task.requested',
    payload: { task_id: `${taskId}-tamper`, task_text: taskText }
  }
  const tamperedRes = await api('POST', '/api/mesh/v1/events', {
    protocolVersion: MESH_PROTOCOL,
    ...tamperedEvent,
    payload: { ...tamperedEvent.payload, task_text: `${taskText}!` },
    signature: meshSignature(phoneIdentity, tamperedEvent)
  })
  check(
    'a payload edited after signing is refused',
    tamperedRes.status === 403,
    `status=${tamperedRes.status}`
  )

  const replay = await publishMeshEvent(phoneIdentity, {
    ticket: dispatchTicket.body?.ticket,
    eventId: `event-${taskId}`,
    subjectNodeId: phoneNodeId,
    targetNodeId: pcNodeId,
    sessionId: meshSession,
    sequence: 1,
    type: 'task.requested',
    payload: { task_id: taskId, task_text: 'different text' }
  })
  check(
    'reusing an event id with a different payload is refused',
    replay.status >= 400,
    `status=${replay.status}`
  )

  const receiptTicket = await meshTicket(pcNodeId, phoneNodeId, meshSession, ['mesh.event.receive'])
  check(
    'desktop obtains a receipt ticket back to the phone',
    receiptTicket.status === 200 && Boolean(receiptTicket.body?.ticket),
    `status=${receiptTicket.status}`
  )
  const receipt = await publishMeshEvent(pcIdentity, {
    ticket: receiptTicket.body?.ticket,
    eventId: `event-${taskId}-done`,
    subjectNodeId: pcNodeId,
    targetNodeId: phoneNodeId,
    sessionId: meshSession,
    sequence: 1,
    type: 'task.completed',
    payload: { task_id: taskId, task_state: 'completed', result_text: '共 12 个文件' }
  })
  check('desktop sends a completion receipt', receipt.status === 202, `status=${receipt.status}`)
  const phoneEvents = await listMeshEvents(phoneNodeId, consoleDeviceToken)
  const received = (phoneEvents.body?.events || []).find(
    (e) => e.eventId === `event-${taskId}-done`
  )
  check(
    'phone receives the receipt with its result text',
    received?.payload?.result_text === '共 12 个文件',
    JSON.stringify(received?.payload || null).slice(0, 120)
  )

  // The relay binds a ticket to an account/session pair, not to an event type.
  // Capability enforcement per direction therefore lives in the desktop verifier
  // (tests/runtime/remote-task-dispatch.test.ts covers both replays). This check
  // pins the server boundary so a future change here is visible.
  const receiptOnlyToPc = await meshTicket(phoneNodeId, pcNodeId, meshSession, [
    'mesh.event.receive'
  ])
  const crossCapability = await publishMeshEvent(phoneIdentity, {
    ticket: receiptOnlyToPc.body?.ticket,
    eventId: `event-${taskId}-cross`,
    subjectNodeId: phoneNodeId,
    targetNodeId: pcNodeId,
    sessionId: meshSession,
    sequence: 5,
    type: 'task.requested',
    payload: { task_id: `${taskId}-cross`, task_text: taskText }
  })
  check(
    'relay does not gate event type by capability (desktop verifier must)',
    crossCapability.status === 202,
    `status=${crossCapability.status}`
  )

  consoleSocket.close()
  pcSocket.close()
  await settle(200)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
  if (failed.length) process.exitCode = 1
}

main().catch((error) => {
  console.error('E2E aborted:', error.message)
  process.exitCode = 1
})
