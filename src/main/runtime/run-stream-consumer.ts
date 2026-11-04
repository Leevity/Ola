import type { RunEvent, RunSnapshot } from '../../shared/runtime/contracts'
import { desktopRuntime } from './desktop-runtime'

export type RunStreamStep =
  | { kind: 'event'; event: RunEvent }
  /** The runtime dropped the subscription; reconcile from the journal. */
  | { kind: 'resync'; reason: string }
  | { kind: 'aborted' }
  | { kind: 'closed' }

export interface MainRunStream {
  snapshot: RunSnapshot
  next: (signal?: AbortSignal) => Promise<RunStreamStep>
  close: () => Promise<void>
}

/**
 * Main-owned counterpart of the renderer stream: a bounded queue in front of
 * `DesktopRuntime.openRunStream` so a consumer can await events instead of
 * polling the journal. Returns `null` when Main cannot push.
 */
export async function openMainRunStream(input: {
  workspaceId: string
  runId: string
  afterSeq: number
}): Promise<MainRunStream | null> {
  if (!desktopRuntime.supportsRunStream) return null
  const queue: RunStreamStep[] = []
  let wake: ((step: RunStreamStep) => void) | null = null
  let closed = false
  let signal: AbortSignal | undefined
  let onAbort: (() => void) | null = null

  const settle = (step: RunStreamStep): void => {
    if (closed) return
    if (wake) {
      // A consumer blocked in next() has an empty queue: hand the step to it
      // directly. Enqueuing here and then calling resolve() would lose the
      // event and make the waiter report a bogus `closed` step.
      const resolve = wake
      wake = null
      resolve(step)
      return
    }
    // A consumer that stops reading must not grow the queue without bound; it
    // will be told to resync instead.
    if (queue.length >= 1024) {
      queue.length = 0
      queue.push({ kind: 'resync', reason: 'SLOW_CONSUMER' })
      return
    }
    queue.push(step)
  }

  const handle = await desktopRuntime.openRunStream({
    workspaceId: input.workspaceId,
    runId: input.runId,
    afterSeq: input.afterSeq,
    onEvent: (event) => settle({ kind: 'event', event }),
    onResync: (reason) => settle({ kind: 'resync', reason })
  })

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    onAbort = null
    const blocked = wake
    wake = null
    blocked?.({ kind: 'closed' })
    await handle.close().catch(() => undefined)
  }

  return {
    snapshot: handle.snapshot,
    next: (abortSignal?: AbortSignal) =>
      new Promise<RunStreamStep>((resolve) => {
        // Queued events win over an abort so a cancelled run still delivers the
        // events it already published.
        const queued = queue.shift()
        if (queued) return resolve(queued)
        if (abortSignal?.aborted) return resolve({ kind: 'aborted' })
        if (closed) return resolve({ kind: 'closed' })
        const listener = (): void => {
          signal?.removeEventListener('abort', listener)
          onAbort = null
          wake = null
          resolve({ kind: 'aborted' })
        }
        signal = abortSignal
        onAbort = abortSignal ? listener : null
        abortSignal?.addEventListener('abort', listener, { once: true })
        wake = (step) => {
          if (abortSignal && onAbort) abortSignal.removeEventListener('abort', onAbort)
          onAbort = null
          resolve(step)
        }
      }),
    close
  }
}
