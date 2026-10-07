import { describe, expect, it, vi } from 'vitest'
import {
  clearSessionAbortController,
  getSessionAbortController,
  hasSessionAbortController,
  registerSessionAbortController,
  waitForSessionRunToSettle
} from '../../src/renderer/src/lib/agent/session-run-lifecycle'

describe('session run lifecycle', () => {
  it('waits until the registered request loop clears its controller', async () => {
    const controller = new AbortController()
    registerSessionAbortController('session-a', controller)

    const settled = waitForSessionRunToSettle('session-a', 100)
    expect(hasSessionAbortController('session-a')).toBe(true)
    clearSessionAbortController('session-a', controller)

    await expect(settled).resolves.toBe(true)
    expect(getSessionAbortController('session-a')).toBeUndefined()
  })

  it('does not let an older request clear a newer request controller', () => {
    const oldController = new AbortController()
    const currentController = new AbortController()
    registerSessionAbortController('session-b', oldController)
    registerSessionAbortController('session-b', currentController)

    clearSessionAbortController('session-b', oldController)

    expect(getSessionAbortController('session-b')).toBe(currentController)
  })

  it('returns false when the request loop does not settle before the timeout', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    registerSessionAbortController('session-c', controller)

    const settled = waitForSessionRunToSettle('session-c', 25)
    await vi.advanceTimersByTimeAsync(25)

    await expect(settled).resolves.toBe(false)
    clearSessionAbortController('session-c', controller)
    vi.useRealTimers()
  })
})
