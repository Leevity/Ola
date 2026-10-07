import { describe, expect, it } from 'vitest'
import { recoverPendingSessionQueue } from '../../src/renderer/src/lib/workbench/pending-session-queue'

describe('pending session queue recovery', () => {
  it('marks an interrupted dispatch for review and preserves queued order', () => {
    expect(
      recoverPendingSessionQueue(
        [
          { id: 'later', text: 'later queued', createdAt: 20, recoveryState: undefined },
          { id: 'in-flight', text: 'maybe sent', createdAt: 10, recoveryState: 'dispatching' },
          { id: 'earlier', text: 'earlier queued', createdAt: 5, recoveryState: undefined },
          null,
          { id: 'bad-time', text: 'invalid timestamp', createdAt: Number.NaN }
        ],
        [],
        50
      )
    ).toEqual([
      { id: 'in-flight', text: 'maybe sent', createdAt: 10, recoveryState: 'needs_review' },
      { id: 'earlier', text: 'earlier queued', createdAt: 5, recoveryState: undefined },
      { id: 'later', text: 'later queued', createdAt: 20, recoveryState: undefined }
    ])
  })

  it('keeps the current copy of a duplicate ID and applies the queue bound', () => {
    const persisted = [
      { id: 'duplicate', text: 'persisted', createdAt: 1, recoveryState: 'dispatching' },
      { id: 'second', text: 'second', createdAt: 2 }
    ]
    const current = [
      { id: 'duplicate', text: 'edited in current view', createdAt: 3 },
      { id: 'third', text: 'third', createdAt: 4 }
    ]

    expect(recoverPendingSessionQueue(persisted, current, 2)).toEqual([
      {
        id: 'duplicate',
        text: 'edited in current view',
        createdAt: 3,
        recoveryState: 'needs_review'
      },
      { id: 'second', text: 'second', createdAt: 2 }
    ])
  })

  it('rejects a malformed persistence response instead of silently treating it as empty', () => {
    expect(() => recoverPendingSessionQueue(null, [], 50)).toThrow(
      'INVALID_PENDING_SESSION_QUEUE_RESPONSE'
    )
  })
})
