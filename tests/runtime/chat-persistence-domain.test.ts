import { describe, expect, it } from 'vitest'
import { SessionPersistenceQueue } from '../../src/renderer/src/stores/chat-persistence-domain'

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
    await queue.enqueue('a', async () => {
      called = true
    }, () => false)
    expect(called).toBe(false)
  })
})
