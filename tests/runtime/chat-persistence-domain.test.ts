import { describe, expect, it } from 'vitest'
import {
  reconcileSessionDeleteResponse,
  SessionCreationGate,
  SessionPersistenceQueue
} from '../../src/renderer/src/stores/chat-persistence-domain'

describe('session delete response reconciliation', () => {
  it('accepts a committed delete after its IPC response was lost', async () => {
    await expect(
      reconcileSessionDeleteResponse(new Error('IPC_RESPONSE_LOST'), async () => false)
    ).resolves.toBeUndefined()
  })

  it('preserves the original error while the session row still exists', async () => {
    const error = new Error('DATABASE_DELETE_FAILED')
    await expect(reconcileSessionDeleteResponse(error, async () => true)).rejects.toBe(error)
  })

  it('does not claim success when the read-back is unavailable', async () => {
    await expect(
      reconcileSessionDeleteResponse(new Error('IPC_RESPONSE_LOST'), async () => {
        throw new Error('READ_BACK_UNAVAILABLE')
      })
    ).rejects.toThrow('READ_BACK_UNAVAILABLE')
  })
})

describe('session creation gate', () => {
  it('retains a completed creation failure until a later successful create', async () => {
    const gate = new SessionCreationGate()
    const failure = new Error('DATABASE_UNAVAILABLE')
    await expect(gate.track('session', Promise.reject(failure))).rejects.toBe(failure)
    await expect(gate.wait('session')).rejects.toBe(failure)
    expect(gate.hasFailure('session')).toBe(true)
    await expect(gate.track('session', Promise.resolve(true))).resolves.toBe(true)
    await expect(gate.wait('session')).resolves.toBeUndefined()
    expect(gate.hasFailure('session')).toBe(false)
  })

  it('waits for an in-flight create without blocking another session', async () => {
    const gate = new SessionCreationGate()
    let release!: () => void
    const pending = gate.track(
      'pending',
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    await expect(gate.wait('other')).resolves.toBeUndefined()
    let settled = false
    const waiting = gate.wait('pending').then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await pending
    await waiting
    expect(settled).toBe(true)
  })

  it('does not let an older failed create overwrite a newer successful attempt', async () => {
    const gate = new SessionCreationGate()
    let rejectOld!: (error: Error) => void
    const old = gate.track(
      'session',
      new Promise<void>((_resolve, reject) => {
        rejectOld = reject
      })
    )
    await gate.track('session', Promise.resolve())
    rejectOld(new Error('STALE_CREATE_FAILED'))
    await expect(old).rejects.toThrow('STALE_CREATE_FAILED')
    await expect(gate.wait('session')).resolves.toBeUndefined()
    expect(gate.hasFailure('session')).toBe(false)
  })

  it('does not run child writes after a failed session create', async () => {
    const gate = new SessionCreationGate()
    const queue = new SessionPersistenceQueue()
    const failure = new Error('DATABASE_UNAVAILABLE')
    await expect(gate.track('session', Promise.reject(failure))).rejects.toBe(failure)
    let childWrites = 0
    await expect(
      queue.enqueueStrict('session', () =>
        gate.runAfterCreation('session', async () => {
          childWrites += 1
        })
      )
    ).rejects.toBe(failure)
    expect(childWrites).toBe(0)

    await gate.track('session', Promise.resolve())
    await queue.enqueueStrict('session', () =>
      gate.runAfterCreation('session', async () => {
        childWrites += 1
      })
    )
    expect(childWrites).toBe(1)
  })

  it('accepts a committed row after the create response failed', async () => {
    const gate = new SessionCreationGate()
    await expect(
      gate.track('session', Promise.reject(new Error('IPC_RESPONSE_LOST')))
    ).rejects.toThrow('IPC_RESPONSE_LOST')
    let retries = 0
    await gate.ensureCreated(
      'session',
      async () => true,
      async () => {
        retries += 1
      }
    )
    expect(retries).toBe(0)
    expect(gate.hasFailure('session')).toBe(false)
  })

  it('retries a missing row once for concurrent callers', async () => {
    const gate = new SessionCreationGate()
    await expect(
      gate.track('session', Promise.reject(new Error('DATABASE_UNAVAILABLE')))
    ).rejects.toThrow('DATABASE_UNAVAILABLE')
    let probes = 0
    let retries = 0
    const exists = async (): Promise<boolean> => {
      probes += 1
      return false
    }
    const retry = async (): Promise<void> => {
      retries += 1
      await gate.track('session', Promise.resolve())
    }
    await Promise.all([
      gate.ensureCreated('session', exists, retry),
      gate.ensureCreated('session', exists, retry)
    ])
    expect(probes).toBe(1)
    expect(retries).toBe(1)
    expect(gate.hasFailure('session')).toBe(false)
  })

  it('keeps a failed create observable when the persistence probe is unavailable', async () => {
    const gate = new SessionCreationGate()
    const failure = new Error('DATABASE_UNAVAILABLE')
    await expect(gate.track('session', Promise.reject(failure))).rejects.toBe(failure)
    await expect(
      gate.ensureCreated(
        'session',
        async () => {
          throw new Error('DATABASE_STILL_UNAVAILABLE')
        },
        async () => {
          throw new Error('RETRY_MUST_NOT_RUN')
        }
      )
    ).rejects.toThrow('DATABASE_STILL_UNAVAILABLE')
    expect(gate.hasFailure('session')).toBe(true)
  })

  it('recognizes a row committed by a retry whose response was lost', async () => {
    const gate = new SessionCreationGate()
    await expect(
      gate.track('session', Promise.reject(new Error('FIRST_RESPONSE_LOST')))
    ).rejects.toThrow('FIRST_RESPONSE_LOST')
    let probeCount = 0
    await gate.ensureCreated(
      'session',
      async () => {
        probeCount += 1
        return probeCount === 2
      },
      async () => {
        await expect(
          gate.track('session', Promise.reject(new Error('RETRY_RESPONSE_LOST')))
        ).rejects.toThrow('RETRY_RESPONSE_LOST')
        throw new Error('RETRY_RESPONSE_LOST')
      }
    )
    expect(probeCount).toBe(2)
    expect(gate.hasFailure('session')).toBe(false)
  })
})

describe('session persistence queue', () => {
  it('serializes writes per session while allowing independent sessions', async () => {
    const queue = new SessionPersistenceQueue()
    const events: string[] = []
    let release!: () => void
    const first = queue.enqueue('a', async () => {
      events.push('a:start')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      events.push('a:end')
    })
    const second = queue.enqueue('a', async () => events.push('a:second'))
    const other = queue.enqueue('b', async () => events.push('b:first'))

    await other
    expect(events).toEqual(['a:start', 'b:first'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['a:start', 'b:first', 'a:end', 'a:second'])
  })

  it('can skip a stale write before execution', async () => {
    const queue = new SessionPersistenceQueue()
    let called = false
    await queue.enqueue(
      'a',
      async () => {
        called = true
      },
      () => false
    )
    expect(called).toBe(false)
  })

  it('reports strict write failures and continues later writes for the session', async () => {
    const queue = new SessionPersistenceQueue()
    const writes: string[] = []
    const failed = queue.enqueueStrict('a', async () => {
      writes.push('failed')
      throw new Error('DATABASE_UNAVAILABLE')
    })
    const resumed = queue.enqueueStrict('a', async () => {
      writes.push('resumed')
    })

    await expect(failed).rejects.toThrow('DATABASE_UNAVAILABLE')
    await expect(resumed).resolves.toBeUndefined()
    expect(writes).toEqual(['failed', 'resumed'])
  })

  it('keeps best-effort writes from rejecting their callers', async () => {
    const queue = new SessionPersistenceQueue()
    await expect(
      queue.enqueue('a', async () => {
        throw new Error('DATABASE_UNAVAILABLE')
      })
    ).resolves.toBeUndefined()
  })
})
