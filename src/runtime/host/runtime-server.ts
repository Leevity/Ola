import { createServer, type Server, type Socket } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeError,
  type RuntimeCapability
} from '../../shared/runtime/contracts'
import { RunScheduler } from '../scheduler/run-scheduler'
import type { ExecutionPageKey } from '../../shared/execution-record'
import { FrameDecoder, encodeFrame } from './framing'

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
  constructor(
    private scheduler: RunScheduler,
    private token: string,
    private authority: RuntimeAuthority,
    options: RuntimeServerOptions = {}
  ) {
    if (token.length < 32) throw new RuntimeError('INVALID_RUNTIME_TOKEN')
    this.capabilities = new Set(options.capabilities ?? RUNTIME_CAPABILITIES)
    this.server = createServer((socket) => this.accept(socket))
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
                    negotiatedCapabilities
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
  private async dispatch(
    method: string,
    input: unknown,
    capabilities: ReadonlySet<RuntimeCapability>
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
      case 'workspace.switch':
        this.requireCapability(capabilities, 'workspace-switch')
        await this.scheduler.switchWorkspace(
          workspaceId,
          allowed,
          (await this.authority.externalBusy?.()) ?? false
        )
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
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    if (this.server.listening)
      await new Promise<void>((resolve, reject) =>
        this.server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}
