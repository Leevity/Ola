import { createHash, createPublicKey, verify } from 'crypto'

export type MeshTaskReceiptDelivery = {
  cursor: number
  protocolVersion: string
  eventId: string
  subjectNodeId: string
  targetNodeId: string
  sessionId: string
  sequence: number
  type: string
  payload: Record<string, unknown>
  capabilities: string[]
  signature: string
  ticket: string
}

export type MeshVerificationNode = {
  nodeId: string
  platform: string
  publicKey: string
}

type MeshTicketClaims = {
  purpose: string
  protocolVersion: string
  ticketId: string
  accountId: string
  subjectNodeId: string
  targetNodeId: string
  sessionId: string
  capabilities: string[]
  nonce: string
  issuedAt: number
  expiresAt: number
}

const TASK_RECEIPT_TYPES = new Set([
  'task.accepted',
  'task.rejected',
  'task.started',
  'task.progress',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.expired'
])
const MESH_EVENT_KEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    return Buffer.from(value, 'base64url')
  } catch {
    return null
  }
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Mesh event payload is not JSON serializable')
  return encoded
}

function verifyEd25519(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false
  try {
    const key = createPublicKey({
      key: Buffer.concat([MESH_EVENT_KEY_PREFIX, publicKey]),
      format: 'der',
      type: 'spki'
    })
    return verify(null, message, key, signature)
  } catch {
    return false
  }
}

function verifyTicket(
  token: string,
  controlPlanePublicKeyText: string,
  expected: Pick<MeshTaskReceiptDelivery, 'subjectNodeId' | 'targetNodeId' | 'sessionId'>,
  accountId: string,
  nowSeconds: number
): MeshTicketClaims | null {
  const [encodedClaims, encodedSignature, extra] = token.split('.')
  if (!encodedClaims || !encodedSignature || extra !== undefined) return null
  const publicKey = decodeBase64Url(controlPlanePublicKeyText)
  const signature = decodeBase64Url(encodedSignature)
  if (
    !publicKey ||
    !signature ||
    !verifyEd25519(publicKey, Buffer.from(encodedClaims), signature)
  ) {
    return null
  }
  const payload = decodeBase64Url(encodedClaims)
  if (!payload) return null
  let claims: MeshTicketClaims
  try {
    claims = JSON.parse(payload.toString('utf8')) as MeshTicketClaims
  } catch {
    return null
  }
  if (
    claims.purpose !== 'mesh-capability' ||
    claims.protocolVersion !== 'v0alpha1' ||
    !claims.ticketId ||
    !claims.nonce ||
    claims.accountId !== accountId ||
    claims.subjectNodeId !== expected.subjectNodeId ||
    claims.targetNodeId !== expected.targetNodeId ||
    claims.sessionId !== expected.sessionId ||
    !claims.capabilities?.includes('mesh.event.receive') ||
    !Number.isInteger(claims.issuedAt) ||
    claims.issuedAt > nowSeconds + 60 ||
    !Number.isInteger(claims.expiresAt) ||
    claims.expiresAt <= nowSeconds
  ) {
    return null
  }
  return claims
}

export function verifyMeshTaskReceiptDelivery(
  delivery: MeshTaskReceiptDelivery,
  nodes: MeshVerificationNode[],
  controlPlanePublicKey: string,
  accountId: string,
  targetNodeId: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): MeshTaskReceiptDelivery {
  if (
    !Number.isSafeInteger(delivery.cursor) ||
    delivery.cursor <= 0 ||
    delivery.protocolVersion !== 'v0alpha2' ||
    !TASK_RECEIPT_TYPES.has(delivery.type) ||
    delivery.targetNodeId !== targetNodeId ||
    !Number.isSafeInteger(delivery.sequence) ||
    delivery.sequence <= 0 ||
    !delivery.capabilities?.includes('mesh.event.receive')
  ) {
    throw new Error('Invalid Mesh task receipt delivery')
  }
  const source = nodes.find((node) => node.nodeId === delivery.subjectNodeId)
  if (!source || (source.platform !== 'android' && source.platform !== 'ios')) {
    throw new Error('Mesh task receipt source is not a registered mobile node')
  }
  const ticket = verifyTicket(
    delivery.ticket,
    controlPlanePublicKey,
    delivery,
    accountId,
    nowSeconds
  )
  if (
    !ticket ||
    ticket.capabilities.length !== delivery.capabilities.length ||
    !ticket.capabilities.every((capability) => delivery.capabilities.includes(capability))
  ) {
    throw new Error('Invalid Mesh task receipt capability ticket')
  }
  const publicKey = decodeBase64Url(source.publicKey)
  const signature = decodeBase64Url(delivery.signature)
  if (!publicKey || !signature) throw new Error('Invalid Mesh task receipt signature encoding')

  const payload = delivery.payload
  const allowedPayloadKeys = new Set(['task_id', 'task_state', 'result_text'])
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).some((key) => !allowedPayloadKeys.has(key)) ||
    typeof payload.task_id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(payload.task_id) ||
    payload.task_state !== delivery.type.slice('task.'.length) ||
    (payload.result_text !== undefined &&
      (delivery.type !== 'task.completed' ||
        typeof payload.result_text !== 'string' ||
        Buffer.byteLength(payload.result_text, 'utf8') > 12 * 1024))
  ) {
    throw new Error('Invalid Mesh task receipt payload')
  }
  const payloadDigest = createHash('sha256').update(sortedJson(payload)).digest('hex')
  const signingInput = [
    delivery.protocolVersion,
    delivery.eventId,
    delivery.subjectNodeId,
    delivery.targetNodeId,
    delivery.sessionId,
    String(delivery.sequence),
    delivery.type,
    payloadDigest
  ].join('\n')
  const digest = createHash('sha256').update(signingInput).digest()
  if (!verifyEd25519(publicKey, digest, signature)) {
    throw new Error('Mesh task receipt signature did not verify')
  }
  return delivery
}
