import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunSnapshot } from '../../src/shared/runtime/contracts'
import type { RunStreamHandle } from '../../src/main/runtime/run-stream-registry'
import { RunStreamRegistry } from '../../src/main/runtime/run-stream-registry'

const snapshot = { events: [] } as unknown as RunSnapshot
const input = { targetId: 'window-1', workspaceId: 'ws', runId: 'run-1', afterSeq: 0 }

function handle(id: string, close: () => Promise<void> = async () => undefined): RunStreamHandle {
  return { subscriptionId: id, snapshot, close: vi.fn(close) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RunStreamRegistry', () => {
  it('only closes the subscription its caller owns', async () => {
    const close = vi.fn(async () => undefined)
    const registry = new RunStreamRegistry(
      async () => handle('sub-1', close),
      () => true
    )
    const subscribed = await registry.subscribe(input)

    // A stale stream of the same run shares the key but must not cancel the live one.
    await registry.unsubscribe(input.targetId, input.runId, 'sub-stale')
    expect(close).not.toHaveBeenCalled()

    await registry.unsubscribe(input.targetId, input.runId, subscribed.subscriptionId)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('still closes when the caller omits the subscription id', async () => {
    const close = vi.fn(async () => undefined)
    const registry = new RunStreamRegistry(
      async () => handle('sub-1', close),
      () => true
    )
    await registry.subscribe(input)
    await registry.unsubscribe(input.targetId, input.runId)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('fails a subscribe whose open never settles instead of holding the lock forever', async () => {
    vi.useFakeTimers()
    let openCalls = 0
    const registry = new RunStreamRegistry(
      () => {
        openCalls += 1
        return new Promise<RunStreamHandle>(() => {})
      },
      () => true
    )

    const pending = registry.subscribe(input)
    const rejected = expect(pending).rejects.toThrow('RUN_STREAM_OPEN_TIMEOUT')
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected

    // The key is free again: the next attempt reaches the opener instead of queueing behind it.
    const retry = registry.subscribe(input)
    const retryRejected = expect(retry).rejects.toThrow('RUN_STREAM_OPEN_TIMEOUT')
    await vi.advanceTimersByTimeAsync(15_000)
    await retryRejected
    expect(openCalls).toBe(2)
  })

  it('closes a handle that resolves after the open timeout', async () => {
    vi.useFakeTimers()
    let resolveOpen!: (value: RunStreamHandle) => void
    const lateClose = vi.fn(async () => undefined)
    const registry = new RunStreamRegistry(
      () =>
        new Promise<RunStreamHandle>((resolve) => {
          resolveOpen = resolve
        }),
      () => true
    )

    const pending = registry.subscribe(input)
    const rejected = expect(pending).rejects.toThrow('RUN_STREAM_OPEN_TIMEOUT')
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected

    resolveOpen(handle('late', lateClose))
    await vi.advanceTimersByTimeAsync(0)
    expect(lateClose).toHaveBeenCalledTimes(1)
  })

  it('does not hold the key or window teardown on a close that never settles', async () => {
    vi.useFakeTimers()
    const close = vi.fn(() => new Promise<void>(() => {}))
    const registry = new RunStreamRegistry(
      async () => handle('sub-1', close),
      () => true
    )
    await registry.subscribe(input)

    const released = registry.releaseTarget(input.targetId)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(released).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)

    // Releasing the same target twice is a no-op, not a second close.
    await registry.releaseTarget(input.targetId)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
