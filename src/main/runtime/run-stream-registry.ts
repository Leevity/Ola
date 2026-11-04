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
export class RunStreamRegistry {
  private subscriptions = new Map<string, RunStreamHandle>()

  constructor(
    private readonly open: RunStreamOpener,
    private readonly send: RunStreamSender
  ) {}

  async subscribe(input: {
    targetId: string
    workspaceId: string
    runId: string
    afterSeq: number
  }): Promise<{ subscriptionId: string; snapshot: RunSnapshot }> {
    const key = this.key(input.targetId, input.runId)
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
    const opened = await this.open({
      workspaceId: input.workspaceId,
      runId: input.runId,
      afterSeq: input.afterSeq,
      onEvent: (event) => {
        if (!subscriptionId) {
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
    handle = opened
    subscriptionId = opened.subscriptionId
    if (resyncReason) {
      await opened.close().catch(() => undefined)
      frame(RUN_RESYNC_CHANNEL, { reason: resyncReason })
      return { subscriptionId, snapshot: opened.snapshot }
    }
    this.subscriptions.set(key, opened)
    let delivered = true
    for (const event of early.splice(0))
      delivered = frame(RUN_EVENT_CHANNEL, { event }) && delivered
    if (!delivered) await this.release(key)
    return { subscriptionId, snapshot: opened.snapshot }
  }

  async unsubscribe(targetId: string, runId: string): Promise<void> {
    await this.release(this.key(targetId, runId))
  }

  /** Drops every subscription owned by a window that went away. */
  async releaseTarget(targetId: string): Promise<void> {
    const prefix = `${targetId}:`
    await Promise.all(
      [...this.subscriptions.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => this.release(key))
    )
  }

  private key(targetId: string, runId: string): string {
    return `${targetId}:${runId}`
  }

  private async release(key: string): Promise<void> {
    const handle = this.subscriptions.get(key)
    if (!handle) return
    this.subscriptions.delete(key)
    await handle.close().catch(() => undefined)
  }
}
