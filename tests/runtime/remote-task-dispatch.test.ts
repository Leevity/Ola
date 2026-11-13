import { createHash, generateKeyPairSync, sign } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  verifyMeshTaskDispatch,
  verifyMeshTaskReceiptDelivery,
  type MeshTaskReceiptDelivery
} from '../../src/main/remote/mesh-events'

const rawKey = (key: ReturnType<typeof generateKeyPairSync>['publicKey']): Buffer =>
  key.export({ format: 'der', type: 'spki' }).subarray(-32)

const canonical = (value: Record<string, unknown>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]])
    )
  )

type FixtureOptions = {
  type?: string
  capabilities?: string[]
  payload?: Record<string, unknown>
  platform?: string
  subjectNodeId?: string
  targetNodeId?: string
  sessionId?: string
  accountId?: string
}

function signedDelivery(options: FixtureOptions = {}) {
  const type = options.type ?? 'task.requested'
  const capabilities = options.capabilities ?? ['task.execute']
  const payload = options.payload ?? { task_id: 'task-01', task_text: '整理本周的会议纪要' }
  const subjectNodeId = options.subjectNodeId ?? 'node-mobile-01'
  const targetNodeId = options.targetNodeId ?? 'node-desktop-01'
  const sessionId = options.sessionId ?? 'session-01'
  const accountId = options.accountId ?? 'account-01'

  const source = generateKeyPairSync('ed25519')
  const controlPlane = generateKeyPairSync('ed25519')
  const claims = {
    purpose: 'mesh-capability',
    protocolVersion: 'v0alpha1',
    ticketId: 'ticket-01',
    accountId,
    subjectNodeId,
    targetNodeId,
    sessionId,
    capabilities,
    nonce: 'nonce-01',
    issuedAt: 100,
    expiresAt: 200
  }
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const ticketSignature = sign(null, Buffer.from(encodedClaims), controlPlane.privateKey).toString(
    'base64url'
  )
  const payloadDigest = createHash('sha256').update(canonical(payload)).digest('hex')
  const digest = createHash('sha256')
    .update(
      [
        'v0alpha2',
        'event-01',
        subjectNodeId,
        targetNodeId,
        sessionId,
        '1',
        type,
        payloadDigest
      ].join('\n')
    )
    .digest()
  const delivery: MeshTaskReceiptDelivery = {
    cursor: 1,
    protocolVersion: 'v0alpha2',
    eventId: 'event-01',
    subjectNodeId,
    targetNodeId,
    sessionId,
    sequence: 1,
    type,
    payload,
    capabilities,
    signature: sign(null, digest, source.privateKey).toString('base64url'),
    ticket: `${encodedClaims}.${ticketSignature}`
  }
  return {
    delivery,
    nodes: [
      {
        nodeId: subjectNodeId,
        platform: options.platform ?? 'android',
        publicKey: rawKey(source.publicKey).toString('base64url')
      }
    ],
    controlPlanePublicKey: rawKey(controlPlane.publicKey).toString('base64url'),
    accountId,
    targetNodeId
  }
}

const verifyDispatch = (fixture: ReturnType<typeof signedDelivery>, now = 150) =>
  verifyMeshTaskDispatch(
    fixture.delivery,
    fixture.nodes,
    fixture.controlPlanePublicKey,
    fixture.accountId,
    fixture.targetNodeId,
    now
  )

describe('Mesh task dispatch verification', () => {
  it('accepts a signed task.requested from a mobile node', () => {
    const fixture = signedDelivery()
    expect(verifyDispatch(fixture)).toEqual(fixture.delivery)
  })

  it('accepts a dispatch from another desktop node', () => {
    const fixture = signedDelivery({ platform: 'macos', subjectNodeId: 'node-desktop-02' })
    expect(verifyDispatch(fixture)).toEqual(fixture.delivery)
  })

  it('preserves UTF-8 task text through canonical signing', () => {
    const fixture = signedDelivery({
      payload: { task_id: 'task-01', task_text: '把 <报告> & 纪要整理成中文' }
    })
    expect(verifyDispatch(fixture).payload.task_text).toBe('把 <报告> & 纪要整理成中文')
  })

  it('accepts task text at the 12 KiB ceiling', () => {
    const fixture = signedDelivery({
      payload: { task_id: 'task-01', task_text: 'a'.repeat(12 * 1024) }
    })
    expect(verifyDispatch(fixture)).toEqual(fixture.delivery)
  })
})

describe('Mesh task dispatch rejects', () => {
  it('a receipt ticket replayed as a dispatch', () => {
    // The two directions must not share a loosened check: mesh.event.receive
    // authorizes publishing a receipt, never enqueueing work.
    const fixture = signedDelivery({ capabilities: ['mesh.event.receive'] })
    expect(() => verifyDispatch(fixture)).toThrow()
  })

  it('a dispatch ticket replayed as a receipt', () => {
    const fixture = signedDelivery({
      type: 'task.completed',
      capabilities: ['task.execute'],
      payload: { task_id: 'task-01', task_state: 'completed' }
    })
    expect(() =>
      verifyMeshTaskReceiptDelivery(
        fixture.delivery,
        fixture.nodes,
        fixture.controlPlanePublicKey,
        fixture.accountId,
        fixture.targetNodeId,
        150
      )
    ).toThrow()
  })

  it.each([
    ['a receipt event type', { type: 'task.completed' }],
    ['an unknown event type', { type: 'task.exploded' }],
    ['empty task text', { payload: { task_id: 'task-01', task_text: '' } }],
    ['whitespace-only task text', { payload: { task_id: 'task-01', task_text: '   \n ' } }],
    ['missing task text', { payload: { task_id: 'task-01' } }],
    [
      'oversized task text',
      { payload: { task_id: 'task-01', task_text: 'a'.repeat(12 * 1024 + 1) } }
    ],
    ['an extra payload key', { payload: { task_id: 'task-01', task_text: 'x', admin: true } }],
    ['a malformed task id', { payload: { task_id: '../etc/passwd', task_text: 'x' } }],
    ['a non-string task id', { payload: { task_id: 42, task_text: 'x' } }]
  ])('%s', (_label, options) => {
    expect(() => verifyDispatch(signedDelivery(options))).toThrow()
  })

  it('a tampered signature', () => {
    const fixture = signedDelivery()
    const altered = Buffer.from(fixture.delivery.signature, 'base64url')
    altered[0] ^= 0xff
    fixture.delivery.signature = altered.toString('base64url')
    expect(() => verifyDispatch(fixture)).toThrow()
  })

  it('a payload edited after signing', () => {
    const fixture = signedDelivery()
    fixture.delivery.payload = { task_id: 'task-01', task_text: 'rm -rf /' }
    expect(() => verifyDispatch(fixture)).toThrow()
  })

  it('an unregistered source node', () => {
    const fixture = signedDelivery()
    expect(() =>
      verifyMeshTaskDispatch(
        fixture.delivery,
        [],
        fixture.controlPlanePublicKey,
        fixture.accountId,
        fixture.targetNodeId,
        150
      )
    ).toThrow()
  })

  it.each([
    ['the wrong account', 'account-02', 'node-desktop-01', 150],
    ['the wrong target', 'account-01', 'node-other', 150],
    ['an expired ticket', 'account-01', 'node-desktop-01', 201]
  ])('%s', (_label, accountId, targetNodeId, now) => {
    const fixture = signedDelivery()
    expect(() =>
      verifyMeshTaskDispatch(
        fixture.delivery,
        fixture.nodes,
        fixture.controlPlanePublicKey,
        accountId,
        targetNodeId,
        now
      )
    ).toThrow()
  })
})
