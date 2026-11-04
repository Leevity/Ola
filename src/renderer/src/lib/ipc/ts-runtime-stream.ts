import type { RunEvent, RunSnapshot } from '../../../../shared/runtime/contracts'
import { invokeMessagePackBinary } from './messagepack-ipc-client'
import { ipcClient } from './ipc-client'

/**
 * One item of a pushed run stream. `resync` means the server stopped pushing
 * and the caller must reconcile with a snapshot; `end` means the local
 * subscription was closed and no further items will arrive.
 */
export type TsRuntimeStreamItem =
  | { kind: 'event'; event: RunEvent }
  | { kind: 'resync'; reason: string }
  | { kind: 'end' }

export interface TsRuntimeRunStream {
  /** Replay up to `afterSeq`; pushed events continue after `snapshot.run.seq`. */
  snapshot: RunSnapshot
  next: () => Promise<TsRuntimeStreamItem>
  close: () => Promise<void>
}

interface RunEventFrame {
  workspaceId: string
  runId: string
  subscriptionId: string
  event: RunEvent
}

interface RunResyncFrame {
  workspaceId: string
  runId: string
  subscriptionId: string
  reason: string
}

type RuntimeResult<T> = T & { error?: string }

function runtimeChannel(name: string): string {
  return `ts-runtime:${name}:msgpack`
}

/**
 * Subscribes to a run's committed events. The renderer receives plain events;
 * the runtime socket, its token and backpressure handling stay in Main.
 *
 * Returns `null` when this build or this Main process cannot push, so the
 * caller can keep using the snapshot loop as a fallback.
 */
export async function openTsRuntimeRunStream(input: {
  workspaceId: string
  runId: string
  afterSeq: number
  signal?: AbortSignal
}): Promise<TsRuntimeRunStream | null> {
  const queue: TsRuntimeStreamItem[] = []
  let waiter: ((item: TsRuntimeStreamItem) => void) | null = null
  let closed = false
  let closeRequested = false
  let unsubscribeSent = false
  let closeInFlight: Promise<void> | null = null

  const push = (item: TsRuntimeStreamItem): void => {
    if (closed) return
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve(item)
      return
    }
    // A reader that stops consuming must not grow the queue without bound.
    if (queue.length >= 1024) {
      queue.length = 0
      queue.push({ kind: 'resync', reason: 'SLOW_CONSUMER' })
      return
    }
    queue.push(item)
  }

  const matches = (frame: { workspaceId?: unknown; runId?: unknown }): boolean =>
    frame.workspaceId === input.workspaceId && frame.runId === input.runId

  let subscriptionId: string | null = null
  const offEvent = ipcClient.on('ts-runtime:run-event', (...args: unknown[]) => {
    const frame = args[0] as RunEventFrame | undefined
    if (!frame || !matches(frame)) return
    // Frames can arrive before the subscribe response names the subscription.
    if (subscriptionId !== null && frame.subscriptionId !== subscriptionId) return
    if (frame.event) push({ kind: 'event', event: frame.event })
  })
  const offResync = ipcClient.on('ts-runtime:run-resync', (...args: unknown[]) => {
    const frame = args[0] as RunResyncFrame | undefined
    if (!frame || !matches(frame)) return
    if (subscriptionId !== null && frame.subscriptionId !== subscriptionId) return
    push({ kind: 'resync', reason: frame.reason ?? 'RESYNC_REQUIRED' })
  })

  /**
   * Idempotent release of the Main-side subscription. It may be called once while
   * `run-subscribe` is still in flight (id unknown) and again after the response
   * arrives, so closing during startup must not leave a live subscription behind.
   */
  const sendUnsubscribe = async (): Promise<void> => {
    if (subscriptionId === null || unsubscribeSent) return
    unsubscribeSent = true
    const owned = subscriptionId
    await invokeMessagePackBinary<RuntimeResult<{ unsubscribed: boolean }>>(
      runtimeChannel('run-unsubscribe'),
      // Main keys subscriptions by window+run, so the id is what proves this stream owns the
      // entry it is about to close.
      { workspaceId: input.workspaceId, runId: input.runId, subscriptionId: owned }
    ).catch(() => undefined)
  }

  const close = async (): Promise<void> => {
    if (closeInFlight) return await closeInFlight
    closeRequested = true
    closed = true
    offEvent()
    offResync()
    input.signal?.removeEventListener('abort', onAbort)
    // Wake a blocked reader: a closed stream must not leave the caller waiting.
    const blocked = waiter
    waiter = null
    blocked?.({ kind: 'end' })
    closeInFlight = sendUnsubscribe()
    return await closeInFlight
  }

  function onAbort(): void {
    void close()
  }

  let subscribed: RuntimeResult<{ subscriptionId: string; snapshot: RunSnapshot | null }>
  try {
    subscribed = await invokeMessagePackBinary<
      RuntimeResult<{ subscriptionId: string; snapshot: RunSnapshot | null }>
    >(runtimeChannel('run-subscribe'), {
      workspaceId: input.workspaceId,
      runId: input.runId,
      afterSeq: input.afterSeq
    })
  } catch (error) {
    closed = true
    offEvent()
    offResync()
    throw error
  }
  const abandoned = (): null => {
    closed = true
    offEvent()
    offResync()
    return null
  }
  // Main answers `PUSH_DISABLED` when it cannot subscribe; the caller then
  // keeps the snapshot loop instead of failing the turn.
  if (subscribed.error === 'PUSH_DISABLED') return abandoned()
  if (subscribed.error) {
    abandoned()
    throw new Error(subscribed.error)
  }
  if (!subscribed.snapshot) {
    abandoned()
    throw new Error('RUN_NOT_FOUND')
  }
  subscriptionId = subscribed.subscriptionId
  // If close()/abort ran while the subscribe call was in flight, Main already
  // created a subscription. Release it now that its id is known.
  if (closeRequested || input.signal?.aborted) {
    await close()
    return null
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })

  return {
    snapshot: subscribed.snapshot,
    next: () =>
      new Promise<TsRuntimeStreamItem>((resolve) => {
        const queued = queue.shift()
        if (queued) return resolve(queued)
        if (closed) return resolve({ kind: 'end' })
        waiter = resolve
      }),
    close
  }
}
