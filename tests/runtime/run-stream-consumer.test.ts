import { describe, expect, it, vi } from 'vitest'
import type { RunEvent, RunSnapshot } from '../../src/shared/runtime/contracts'

const runtime = vi.hoisted(() => ({
  supportsRunStream: true,
  openRunStream: vi.fn()
}))

vi.mock('../../src/main/runtime/desktop-runtime', () => ({
  desktopRuntime: runtime
}))

import { openMainRunStream } from '../../src/main/runtime/run-stream-consumer'

type Hooks = {
  onEvent: (event: RunEvent) => void
  onResync: (reason: string) => void
}

function event(seq: number): RunEvent {
  return { seq, type: 'message.delta', data: { text: String(seq) } } as unknown as RunEvent
}

function install(hooks: Hooks): void {
  runtime.openRunStream.mockImplementation(async (options: Hooks) => {
    hooks.onEvent = options.onEvent
    hooks.onResync = options.onResync
    return {
      subscriptionId: 'sub-1',
      snapshot: { events: [] } as unknown as RunSnapshot,
      close: async () => undefined
    }
  })
}

describe('openMainRunStream', () => {
  it('delivers an event that arrives while the consumer is waiting', async () => {
    const hooks = {} as Hooks
    install(hooks)
    const stream = await openMainRunStream({ workspaceId: 'w', runId: 'r', afterSeq: 0 })
    expect(stream).not.toBeNull()

    const pending = stream!.next()
    hooks.onEvent(event(1))
    const step = await pending
    expect(step.kind).toBe('event')
    if (step.kind === 'event') expect(step.event.seq).toBe(1)
    await stream!.close()
  })

  it('keeps queued events in order and does not invent a closed step', async () => {
    const hooks = {} as Hooks
    install(hooks)
    const stream = await openMainRunStream({ workspaceId: 'w', runId: 'r', afterSeq: 0 })
    hooks.onEvent(event(1))
    hooks.onEvent(event(2))
    expect((await stream!.next()).kind).toBe('event')
    expect((await stream!.next()).kind).toBe('event')
    const aborted = new AbortController()
    aborted.abort()
    expect((await stream!.next(aborted.signal)).kind).toBe('aborted')
    await stream!.close()
  })

  it('resolves a waiting consumer with closed when the stream is closed', async () => {
    const hooks = {} as Hooks
    install(hooks)
    const stream = await openMainRunStream({ workspaceId: 'w', runId: 'r', afterSeq: 0 })
    const pending = stream!.next()
    await stream!.close()
    expect((await pending).kind).toBe('closed')
  })

  it('resolves a waiting consumer with resync when the runtime drops the subscription', async () => {
    const hooks = {} as Hooks
    install(hooks)
    const stream = await openMainRunStream({ workspaceId: 'w', runId: 'r', afterSeq: 0 })
    const pending = stream!.next()
    hooks.onResync('SLOW_CONSUMER')
    const step = await pending
    expect(step.kind).toBe('resync')
    if (step.kind === 'resync') expect(step.reason).toBe('SLOW_CONSUMER')
    await stream!.close()
  })
})
