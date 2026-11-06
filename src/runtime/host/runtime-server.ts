import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeError,
  type RunEvent,
  type RuntimeCapability
} from '../../shared/runtime/contracts'
import { RunScheduler } from '../scheduler/run-scheduler'
import type { ExecutionPageKey } from '../../shared/execution-record'
import { FrameDecoder, encodeFrame } from './framing'

/**
 * A stalled consumer must never look like a disconnected one: past this queued
 * byte count the server drops the subscription and asks the client to resync
 * from the journal instead of destroying the socket.
 */
const MAX_SUBSCRIPTION_BUFFER_BYTES = 512 * 1024

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted'
])

/** A terminal `run.status` is the run's last event, so the subscription ends there. */
function isTerminalRunEvent(event: RunEvent): boolean {
  if (event.type !== 'run.status') return false
  const data = event.data
  return (
    !!data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    TERMINAL_RUN_STATUSES.has(String((data as Record<string, unknown>).status))
  )
}

interface RunSubscription {
  subscriptionId: string
  runId: string
  workspaceId: string
  /** Highest sequence handed to this subscriber; used to drop replays on resubscribe. */
  lastSeq: number
  /** Events that arrived while the subscription's first snapshot was being read. */
  buffered: RunEvent[]
  ready: boolean
}

interface SocketConnection {
  socket: Socket
  subscriptions: Map<string, RunSubscription>
  /** Reverse index so a terminal event or a workspace switch can drop matching runs. */
  byRun: Map<string, Set<string>>
}

export interface RuntimeAuthority {
  workspaceIds: () => Promise<ReadonlySet<string>>
  externalBusy?: () => Promise<boolean>
}

export interface RuntimeServerOptions {
  capabilities?: readonly RuntimeCapability[]
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_REQUEST')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    throw new RuntimeError('INVALID_REQUEST')
  return value.trim()
}
function pageKey(value: unknown): ExecutionPageKey | undefined {
  if (value === undefined) return undefined
  const candidate = record(value)
  if (
    Object.keys(candidate).some((key) => key !== 'at' && key !== 'id') ||
    typeof candidate.at !== 'number' ||
    !Number.isSafeInteger(candidate.at) ||
    candidate.at < 0
  )
    throw new RuntimeError('INVALID_REQUEST')
  return { at: candidate.at, id: id(candidate.id) }
}
function matchesToken(left: unknown, right: string): boolean {
  if (typeof left !== 'string') return false
  const a = Buffer.from(left),
    b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
function requestedCapabilities(value: unknown): readonly RuntimeCapability[] {
  if (value === undefined) return RUNTIME_CAPABILITIES
  if (!Array.isArray(value) || value.length > RUNTIME_CAPABILITIES.length)
    throw new RuntimeError('INVALID_REQUEST')
  const requested = value.map((item) => {
    if (typeof item !== 'string' || !RUNTIME_CAPABILITIES.includes(item as RuntimeCapability))
      throw new RuntimeError('INVALID_REQUEST')
    return item as RuntimeCapability
  })
  if (new Set(requested).size !== requested.length) throw new RuntimeError('INVALID_REQUEST')
  return requested
}

export class RuntimeServer {
  private server: Server
  private sockets = new Set<Socket>()
  private connections = new Map<Socket, SocketConnection>()
  private releaseSchedulerEvents: (() => void) | null = null
  constructor(
    private scheduler: RunScheduler,
    private token: string,
    private authority: RuntimeAuthority,
    options: RuntimeServerOptions = {}
  ) {
    if (token.length < 32) throw new RuntimeError('INVALID_RUNTIME_TOKEN')
    this.capabilities = new Set(options.capabilities ?? RUNTIME_CAPABILITIES)
    this.server = createServer((socket) => this.accept(socket))
    // Subscriptions are fed from the same committed events the journal replays,
    // so a push and a snapshot can never disagree about a run's history.
    this.releaseSchedulerEvents = this.scheduler.onEvent((event) => this.publishEvent(event))
  }
  private capabilities: ReadonlySet<RuntimeCapability>
  async listen(endpoint: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => reject(error)
      this.server.once('error', fail)
      this.server.listen(endpoint, () => {
        this.server.off('error', fail)
        resolve()
      })
    })
    if (process.platform !== 'win32') await chmod(endpoint, 0o600)
  }
  private accept(socket: Socket): void {
    this.sockets.add(socket)
    const connection: SocketConnection = { socket, subscriptions: new Map(), byRun: new Map() }
    this.connections.set(socket, connection)
    const decoder = new FrameDecoder()
    let authenticated = false
    let negotiatedCapabilities: ReadonlySet<RuntimeCapability> = new Set()
    let inflight = 0
    let tail: Promise<unknown> = Promise.resolve()
    const timeout = setTimeout(() => socket.destroy(), 5000)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(timeout)
      this.sockets.delete(socket)
      const closed = this.connections.get(socket)
      this.connections.delete(socket)
      closed?.subscriptions.clear()
      closed?.byRun.clear()
    })
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (++inflight > 32) {
            socket.destroy()
            return
          }
          tail = tail
            .then(async () => {
              let requestId: string | undefined
              try {
                const request = record(frame)
                requestId = id(request.id)
                if (!authenticated) {
                  const params = record(request.params)
                  if (
                    request.method !== 'hello' ||
                    params.version !== RUNTIME_PROTOCOL_VERSION ||
                    !matchesToken(params.token, this.token)
                  )
                    throw new RuntimeError('HANDSHAKE_REJECTED')
                  const requested = requestedCapabilities(params.capabilities)
                  authenticated = true
                  negotiatedCapabilities = new Set(
                    requested.filter((capability) => this.capabilities.has(capability))
                  )
                  clearTimeout(timeout)
                  this.send(socket, {
                    id: requestId,
                    result: {
                      version: RUNTIME_PROTOCOL_VERSION,
                      capabilities: [...negotiatedCapabilities]
                    }
                  })
                } else {
                  const result = await this.dispatch(
                    id(request.method),
                    request.params,
                    negotiatedCapabilities,
                    connection
                  )
                  this.send(socket, { id: requestId, result })
                }
              } catch (error) {
                this.send(socket, {
                  id: requestId,
                  error: error instanceof RuntimeError ? error.code : 'REQUEST_FAILED'
                })
                if (!authenticated) socket.end()
              } finally {
                inflight--
              }
            })
            .catch(() => socket.destroy())
        }
      } catch {
        socket.destroy()
      }
    })
  }
  private send(socket: Socket, value: unknown): void {
    if (socket.destroyed) return
    // A stalled UI can reconnect/replay; it must not consume unbounded service memory.
    if (socket.writableLength > 2 * 1024 * 1024) {
      socket.destroy()
      return
    }
    socket.write(encodeFrame(value))
  }

  /** Fans a committed event out to every socket subscribed to its run. */
  private publishEvent(event: RunEvent): void {
    for (const connection of this.connections.values()) {
      for (const subscriptionId of [...(connection.byRun.get(event.runId) ?? [])]) {
        const subscription = connection.subscriptions.get(subscriptionId)
        if (!subscription || subscription.workspaceId !== event.workspaceId) continue
        if (!subscription.ready) {
          subscription.buffered.push(event)
          // A snapshot read that cannot keep up must not buffer without bound.
          if (subscription.buffered.length > 512)
            this.dropSubscription(connection, subscription, 'RESYNC_REQUIRED')
          continue
        }
        // Replays after a resubscribe can repeat an already-delivered event.
        if (event.seq <= subscription.lastSeq) continue
        this.deliver(connection, subscription, event)
      }
    }
  }

  private deliver(
    connection: SocketConnection,
    subscription: RunSubscription,
    event: RunEvent
  ): void {
    const { socket } = connection
    if (socket.destroyed) return
    // Backpressure degrades to a resync hint rather than a disconnect: the
    // journal remains the single source of truth for a run's events.
    if (socket.writableLength > MAX_SUBSCRIPTION_BUFFER_BYTES) {
      this.dropSubscription(connection, subscription, 'SLOW_CONSUMER')
      return
    }
    subscription.lastSeq = event.seq
    socket.write(
      encodeFrame({
        event: 'run.event',
        subscriptionId: subscription.subscriptionId,
        payload: event
      })
    )
    // A finished run has nothing left to push; keeping the subscription would
    // pin both the journal reader and this socket for a run nobody watches.
    if (isTerminalRunEvent(event)) this.removeSubscription(connection, subscription.subscriptionId)
  }

  private dropSubscription(
    connection: SocketConnection,
    subscription: RunSubscription,
    reason: string
  ): void {
    this.removeSubscription(connection, subscription.subscriptionId)
    if (connection.socket.destroyed) return
    connection.socket.write(
      encodeFrame({ event: 'run.resync', subscriptionId: subscription.subscriptionId, reason })
    )
  }

  private removeSubscription(connection: SocketConnection, subscriptionId: string): void {
    const subscription = connection.subscriptions.get(subscriptionId)
    if (!subscription) return
    connection.subscriptions.delete(subscriptionId)
    const runSubscriptions = connection.byRun.get(subscription.runId)
    runSubscriptions?.delete(subscriptionId)
    if (runSubscriptions && runSubscriptions.size === 0) connection.byRun.delete(subscription.runId)
  }
  private async dispatch(
    method: string,
    input: unknown,
    capabilities: ReadonlySet<RuntimeCapability>,
    connection: SocketConnection
  ): Promise<unknown> {
    const params = record(input)
    if (method === 'ping') return { version: RUNTIME_PROTOCOL_VERSION }
    const workspaceId = id(params.workspaceId)
    const allowed = await this.authority.workspaceIds()
    if (!allowed.has(workspaceId)) throw new RuntimeError('WORKSPACE_FORBIDDEN')
    switch (method) {
      case 'run.submit':
        this.requireCapability(capabilities, 'runs')
        return this.scheduler.submit(params)
      case 'run.snapshot': {
        this.requireCapability(capabilities, 'replay')
        const after = params.afterSeq ?? 0
        if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0)
          throw new RuntimeError('INVALID_REQUEST')
        const snapshot = await this.scheduler.journal.snapshot(id(params.runId), workspaceId, after)
        await this.requireCurrentWorkspaceAccess(workspaceId)
        return snapshot
      }
      case 'run.list': {
        this.requireCapability(capabilities, 'runs')
        const limit = params.limit ?? 100
        const offset = params.offset ?? 0
        const attentionOnly = params.attentionOnly ?? false
        if (
          typeof limit !== 'number' ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 200 ||
          typeof offset !== 'number' ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          typeof attentionOnly !== 'boolean'
        )
          throw new RuntimeError('INVALID_REQUEST')
        const runs = await this.scheduler.journal.list(
          workspaceId,
          limit,
          offset,
          attentionOnly,
          pageKey(params.anchor),
          pageKey(params.after)
        )
        await this.requireCurrentWorkspaceAccess(workspaceId)
        return runs
      }
      case 'artifact.list': {
        this.requireCapability(capabilities, 'runs')
        const limit = params.limit ?? 50
        const offset = params.offset ?? 0
        if (
          typeof limit !== 'number' ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 200 ||
          typeof offset !== 'number' ||
          !Number.isSafeInteger(offset) ||
          offset < 0
        )
          throw new RuntimeError('INVALID_REQUEST')
        const runId = params.runId === undefined ? undefined : id(params.runId)
        const artifacts = await this.scheduler.journal.artifacts(workspaceId, limit, offset, runId)
        await this.requireCurrentWorkspaceAccess(workspaceId)
        return artifacts
      }
      case 'artifact.hide': {
        this.requireCapability(capabilities, 'runs')
        const seq = params.seq
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1)
          throw new RuntimeError('INVALID_REQUEST')
        const result = await this.scheduler.journal.hideArtifact(workspaceId, id(params.runId), seq)
        await this.requireCurrentWorkspaceAccess(workspaceId)
        return result
      }
      case 'run.cancel':
        this.requireCapability(capabilities, 'cancel')
        await this.scheduler.cancel(id(params.runId), workspaceId)
        return { ok: true }
      case 'run.cancel-session': {
        this.requireCapability(capabilities, 'cancel')
        const sessionId = id(params.sessionId)
        await this.scheduler.cancelSessionRuns(workspaceId, sessionId)
        await this.requireCurrentWorkspaceAccess(workspaceId)
        return { ok: true }
      }
      case 'run.interact':
        this.requireCapability(capabilities, 'interactions')
        await this.scheduler.respondInteraction(
          id(params.runId),
          workspaceId,
          id(params.interactionId),
          params.response
        )
        return { ok: true }
      case 'run.subscribe': {
        this.requireCapability(capabilities, 'replay')
        this.requireCapability(capabilities, 'stream')
        const runId = id(params.runId)
        const after = params.afterSeq ?? 0
        if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0)
          throw new RuntimeError('INVALID_REQUEST')
        const subscription: RunSubscription = {
          // The client may name its subscription so it can correlate pushed
          // frames that arrive before this response.
          subscriptionId:
            params.subscriptionId === undefined ? randomUUID() : id(params.subscriptionId),
          runId,
          workspaceId,
          lastSeq: after,
          buffered: [],
          ready: false
        }
        // Register before reading the snapshot: anything the scheduler commits
        // during that read is buffered, so the stream has no hole at its head.
        if (connection.subscriptions.has(subscription.subscriptionId))
          throw new RuntimeError('INVALID_REQUEST')
        connection.subscriptions.set(subscription.subscriptionId, subscription)
        const runSubscriptions = connection.byRun.get(runId) ?? new Set<string>()
        runSubscriptions.add(subscription.subscriptionId)
        connection.byRun.set(runId, runSubscriptions)
        try {
          const snapshot = await this.scheduler.journal.snapshot(runId, workspaceId, after)
          if (!snapshot) throw new RuntimeError('RUN_NOT_FOUND')
          await this.requireCurrentWorkspaceAccess(workspaceId)
          // A finished run has nothing left to push, so the snapshot alone is
          // the whole subscription; the caller consumes it and closes.
          if (TERMINAL_RUN_STATUSES.has(snapshot.run.status)) {
            this.removeSubscription(connection, subscription.subscriptionId)
            return { subscriptionId: subscription.subscriptionId, snapshot }
          }
          // The snapshot body is the replay; only events committed after it are
          // still owed to this subscriber.
          subscription.lastSeq = Math.max(subscription.lastSeq, snapshot.run.seq)
          const pending = subscription.buffered.filter((event) => event.seq > subscription.lastSeq)
          subscription.buffered = []
          subscription.ready = true
          for (const event of pending) {
            if (!connection.subscriptions.has(subscription.subscriptionId)) break
            this.deliver(connection, subscription, event)
          }
          return { subscriptionId: subscription.subscriptionId, snapshot }
        } catch (error) {
          this.removeSubscription(connection, subscription.subscriptionId)
          throw error
        }
      }
      case 'run.unsubscribe': {
        this.requireCapability(capabilities, 'stream')
        const runId = id(params.runId)
        const subscriptionId =
          params.subscriptionId === undefined ? undefined : id(params.subscriptionId)
        const targets = subscriptionId ? [subscriptionId] : [...(connection.byRun.get(runId) ?? [])]
        for (const target of targets) this.removeSubscription(connection, target)
        return { ok: true }
      }
      case 'workspace.switch':
        this.requireCapability(capabilities, 'workspace-switch')
        await this.scheduler.switchWorkspace(
          workspaceId,
          allowed,
          (await this.authority.externalBusy?.()) ?? false
        )
        // A socket keeps only subscriptions it is still allowed to observe. The resync frame is
        // what releases a waiting subscriber; a silent removal would stall its stream forever.
        for (const subscription of [...connection.subscriptions.values()]) {
          if (!allowed.has(subscription.workspaceId))
            this.dropSubscription(connection, subscription, 'WORKSPACE_REVOKED')
        }
        return { ok: true }
      default:
        throw new RuntimeError('UNKNOWN_METHOD')
    }
  }
  private requireCapability(
    capabilities: ReadonlySet<RuntimeCapability>,
    capability: RuntimeCapability
  ): void {
    if (!capabilities.has(capability)) throw new RuntimeError('CAPABILITY_UNAVAILABLE')
  }
  private async requireCurrentWorkspaceAccess(workspaceId: string): Promise<void> {
    if (!(await this.authority.workspaceIds()).has(workspaceId))
      throw new RuntimeError('WORKSPACE_FORBIDDEN')
  }
  /** Drops every subscription for workspaces that are no longer permitted. */
  revokeUnavailableWorkspaces(availableIds: ReadonlySet<string>): void {
    for (const connection of this.connections.values()) {
      for (const subscription of [...connection.subscriptions.values()]) {
        if (!availableIds.has(subscription.workspaceId))
          this.dropSubscription(connection, subscription, 'WORKSPACE_REVOKED')
      }
    }
  }
  async close(): Promise<void> {
    this.releaseSchedulerEvents?.()
    this.releaseSchedulerEvents = null
    for (const socket of this.sockets) socket.destroy()
    this.connections.clear()
    if (this.server.listening)
      await new Promise<void>((resolve, reject) =>
        this.server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}
