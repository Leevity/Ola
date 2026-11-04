import type { RunEvent, RunSnapshot } from '../../shared/runtime/contracts'

export const RUN_EVENT_CHANNEL = 'ts-runtime:run-event'
export const RUN_RESYNC_CHANNEL = 'ts-runtime:run-resync'

export interface RunStreamOpenOptions {
  workspaceId: string
  runId: string
  afterSeq: number
  onEvent: (event: RunEvent) => void
  onResync: (reason: string) => void
}

export interface RunStreamHandle {
  subscriptionId: string
  snapshot: RunSnapshot
  close: () => Promise<void>
}

export type RunStreamOpener = (options: RunStreamOpenOptions) => Promise<RunStreamHandle>

/**
 * Writes one frame to one window and reports whether that window is still
 * allowed to receive the run. The bridge rechecks the window's workspace
 * registration, so a workspace switch stops delivery immediately.
 */
export type RunStreamSender = (
  targetId: string,
  channel: string,
  workspaceId: string,
  payload: unknown
) => boolean

/**
 * Bridges renderer subscriptions onto the single Main-owned runtime client.
 * Each window owns its own runtime subscription: a shared one would have to
 * fan out to windows with independent lifecycles, and the runtime already
 * multiplexes subscriptions per socket.
 */
/** Frames pushed before `open()` resolves are bounded; overflow asks the window to resync. */
const MAX_EARLY_EVENTS = 1024
/**
 * One key's lock must never wait on an unbounded promise: a single hung `open()` or `close()`
 * would otherwise block every later subscription of that run, and `releaseTarget` would hang on
 * window teardown. Both sides are bounded and a timeout is reported as a failure, not a success.
 */
const OPEN_TIMEOUT_MS = 15_000
const CLOSE_TIMEOUT_MS = 5_000

async function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), ms)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class RunStreamRegistry {
  private subscriptions = new Map<string, RunStreamHandle>()
  private tails = new Map<string, Promise<unknown>>()

  constructor(
    private readonly open: RunStreamOpener,
    private readonly send: RunStreamSender
  ) {}

  /** Serialize all mutations of one key so concurrent re-subscriptions cannot leak handles. */
  private async withKey<T>(key: string, task: (key: string) => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const tail = prior.catch(() => undefined).then(() => gate)
    this.tails.set(key, tail)
    await prior.catch(() => undefined)
    try {
      return await task(key)
    } finally {
      finish()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  async subscribe(input: {
    targetId: string
    workspaceId: string
    runId: string
    afterSeq: number
  }): Promise<{ subscriptionId: string; snapshot: RunSnapshot }> {
    return await this.withKey(this.key(input.targetId, input.runId), (key) =>
      this.subscribeLocked(key, input)
    )
  }

  private async subscribeLocked(
    key: string,
    input: {
      targetId: string
      workspaceId: string
      runId: string
      afterSeq: number
    }
  ): Promise<{ subscriptionId: string; snapshot: RunSnapshot }> {
    // Re-subscribing over a live subscription must not leak the previous one.
    await this.release(key)
    // The runtime can push before `open()` resolves, which is before the
    // subscription id is known. Hold those frames until it can be named.
    const early: RunEvent[] = []
    let resyncReason: string | null = null
    let subscriptionId: string | null = null
    let handle: RunStreamHandle | null = null
    const frame = (channel: string, payload: Record<string, unknown>): boolean =>
      this.send(input.targetId, channel, input.workspaceId, {
        workspaceId: input.workspaceId,
        runId: input.runId,
        subscriptionId,
        ...payload
      })
    const opening = this.open({
      workspaceId: input.workspaceId,
      runId: input.runId,
      afterSeq: input.afterSeq,
      onEvent: (event) => {
        if (!subscriptionId) {
          if (early.length >= MAX_EARLY_EVENTS) {
            early.length = 0
            resyncReason = 'SLOW_CONSUMER'
            return
          }
          early.push(event)
          return
        }
        // A window that left the workspace, or went away, keeps no
        // subscription: the journal replay covers whatever was missed.
        if (!frame(RUN_EVENT_CHANNEL, { event })) void this.release(key)
      },
      onResync: (reason) => {
        if (!subscriptionId) {
          resyncReason = reason
          return
        }
        // The runtime already dropped the subscription; forget it before the
        // window can resubscribe so a stale entry never blocks the retry.
        if (this.subscriptions.get(key) === handle) this.subscriptions.delete(key)
        frame(RUN_RESYNC_CHANNEL, { reason })
      }
    })
    const opened = await withTimeout(opening, OPEN_TIMEOUT_MS, 'RUN_STREAM_OPEN_TIMEOUT').catch(
      async (error: unknown) => {
        // `open()` may still resolve after the lock gave up; close that late handle so a timed-out
        // subscribe cannot leave an orphaned runtime subscription behind.
        void opening.then((late) => late.close()).catch(() => undefined)
        throw error
      }
    )
    // Register before exposing the id: an onEvent that arrives while early frames
    // are flushed may call release(key), which must be able to close this handle.
    this.subscriptions.set(key, opened)
    handle = opened
    subscriptionId = opened.subscriptionId
    if (resyncReason) {
      this.subscriptions.delete(key)
      await opened.close().catch(() => undefined)
      frame(RUN_RESYNC_CHANNEL, { reason: resyncReason })
      return { subscriptionId, snapshot: opened.snapshot }
    }
    let delivered = true
    for (const event of early.splice(0))
      delivered = frame(RUN_EVENT_CHANNEL, { event }) && delivered
    if (!delivered) await this.release(key)
    return { subscriptionId, snapshot: opened.snapshot }
  }

  /**
   * Drops one subscription. `subscriptionId` is optional for the internal teardown paths, but a
   * renderer must send it: the registry key is only `targetId:runId`, so two streams of the same
   * run in one window share a key and a stale unsubscribe would cancel the newer stream.
   */
  async unsubscribe(targetId: string, runId: string, subscriptionId?: string): Promise<void> {
    const key = this.key(targetId, runId)
    await this.withKey(key, async () => {
      const handle = this.subscriptions.get(key)
      if (subscriptionId !== undefined && handle?.subscriptionId !== subscriptionId) return
      await this.release(key)
    })
  }

  /** Drops every subscription owned by a window that went away. */
  async releaseTarget(targetId: string): Promise<void> {
    const prefix = `${targetId}:`
    // `allSettled`: one unreachable key must not leave the other subscriptions of a closed
    // window alive (window teardown cannot report a partial failure anyway).
    await Promise.allSettled(
      [...this.subscriptions.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => this.withKey(key, async () => await this.release(key)))
    )
  }

  private key(targetId: string, runId: string): string {
    return `${targetId}:${runId}`
  }

  private async release(key: string): Promise<void> {
    const handle = this.subscriptions.get(key)
    if (!handle) return
    this.subscriptions.delete(key)
    // A close that never settles must not keep the key's lock held.
    await withTimeout(
      handle.close().catch(() => undefined),
      CLOSE_TIMEOUT_MS,
      'RUN_STREAM_CLOSE_TIMEOUT'
    ).catch(() => undefined)
  }
}
