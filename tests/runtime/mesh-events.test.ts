import { createHash, generateKeyPairSync, sign } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  verifyMeshTaskReceiptDelivery,
  type MeshTaskReceiptDelivery
} from '../../src/main/remote/mesh-events'

const rawKey = (key: ReturnType<typeof generateKeyPairSync>['publicKey']): Buffer =>
  key.export({ format: 'der', type: 'spki' }).subarray(-32)

function signedReceipt(): {
  delivery: MeshTaskReceiptDelivery
  nodes: [{ nodeId: string; platform: string; publicKey: string }]
  controlPlanePublicKey: string
} {
  const mobile = generateKeyPairSync('ed25519')
  const controlPlane = generateKeyPairSync('ed25519')
  const claims = {
    purpose: 'mesh-capability',
    protocolVersion: 'v0alpha1',
    ticketId: 'ticket-01',
    accountId: 'account-01',
    subjectNodeId: 'node-mobile-01',
    targetNodeId: 'node-desktop-01',
    sessionId: 'session-01',
    capabilities: ['mesh.event.receive'],
    nonce: 'nonce-01',
    issuedAt: 100,
    expiresAt: 200
  }
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const ticketSignature = sign(null, Buffer.from(encodedClaims), controlPlane.privateKey).toString(
    'base64url'
  )
  const payload = {
    task_id: 'task-01',
    task_state: 'completed',
    result_text: '完成 <任务> & safely'
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
        'event-01',
        claims.subjectNodeId,
        claims.targetNodeId,
        claims.sessionId,
        '1',
        'task.completed',
        payloadDigest
      ].join('\n')
    )
    .digest()
  const delivery: MeshTaskReceiptDelivery = {
    cursor: 1,
    protocolVersion: 'v0alpha2',
    eventId: 'event-01',
    subjectNodeId: claims.subjectNodeId,
    targetNodeId: claims.targetNodeId,
    sessionId: claims.sessionId,
    sequence: 1,
    type: 'task.completed',
    payload,
    capabilities: claims.capabilities,
    signature: sign(null, digest, mobile.privateKey).toString('base64url'),
    ticket: `${encodedClaims}.${ticketSignature}`
  }
  return {
    delivery,
    nodes: [
      {
        nodeId: claims.subjectNodeId,
        platform: 'android',
        publicKey: rawKey(mobile.publicKey).toString('base64url')
      }
    ],
    controlPlanePublicKey: rawKey(controlPlane.publicKey).toString('base64url')
  }
}

describe('Mesh task receipt verification', () => {
  it('accepts a signed mobile receipt with UTF-8 and HTML characters', () => {
    const fixture = signedReceipt()
    expect(
      verifyMeshTaskReceiptDelivery(
        fixture.delivery,
        fixture.nodes,
        fixture.controlPlanePublicKey,
        'account-01',
        'node-desktop-01',
        150
      )
    ).toEqual(fixture.delivery)
  })

  it.each([
    ['wrong account', { accountId: 'account-02', targetNodeId: 'node-desktop-01', now: 150 }],
    ['wrong target', { accountId: 'account-01', targetNodeId: 'node-other', now: 150 }],
    ['expired ticket', { accountId: 'account-01', targetNodeId: 'node-desktop-01', now: 201 }]
  ])('rejects a receipt with %s', (_label, expected) => {
    const fixture = signedReceipt()
    expect(() =>
      verifyMeshTaskReceiptDelivery(
        fixture.delivery,
        fixture.nodes,
        fixture.controlPlanePublicKey,
        expected.accountId,
        expected.targetNodeId,
        expected.now
      )
    ).toThrow()
  })

  it('rejects a modified event signature', () => {
    const fixture = signedReceipt()
    const alteredSignature = Buffer.from(fixture.delivery.signature, 'base64url')
    alteredSignature[0] ^= 0xff
    fixture.delivery.signature = alteredSignature.toString('base64url')
    expect(() =>
      verifyMeshTaskReceiptDelivery(
        fixture.delivery,
        fixture.nodes,
        fixture.controlPlanePublicKey,
        'account-01',
        'node-desktop-01',
        150
      )
    ).toThrow()
  })
})
