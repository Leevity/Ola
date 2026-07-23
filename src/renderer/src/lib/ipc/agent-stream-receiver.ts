import type {
  AgentStreamEnvelope,
  AgentStreamEvent
} from '../../../../shared/agent-stream-protocol'
import { AGENT_STREAM_PROTOCOL_VERSION } from '../../../../shared/agent-stream-protocol'
import {
  AGENT_STREAM_MSGPACK_CHANNEL,
  decodeAgentStreamEnvelopes
} from '../../../../shared/messagepack/agent-stream-codec'
import { ipcClient } from './ipc-client'

type RunEventCallback = (event: AgentStreamEvent) => void
type GlobalEventCallback = (runId: string, sessionId: string, event: AgentStreamEvent) => void

type AgentStreamReplayResponse = {
  recoverable: boolean
  frames: AgentStreamEnvelope[]
  firstAvailableSeq?: number
  lastAvailableSeq?: number
  reason?: 'not_found' | 'expired' | 'not_owner' | 'gap_not_buffered'
}

export class AgentStreamReceiver {
  private runHandlers = new Map<string, Set<RunEventCallback>>()
  private globalHandlers = new Set<GlobalEventCallback>()
  private lastSeqByRun = new Map<string, number>()
  private unrecoverableRunIds = new Set<string>()
  private processingChains = new Map<string, Promise<void>>()
  private attached = false

  attach(): void {
    if (this.attached) return
    this.attached = true

    window.ola.ipc.on(AGENT_STREAM_MSGPACK_CHANNEL, (bytes: unknown) => {
      if (!(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))) return
      const startedAt = performance.now()
      try {
        const envelopes = decodeAgentStreamEnvelopes(bytes)
        const metrics = {
          byteLength: getByteLength(bytes),
          decodeMs: Math.round((performance.now() - startedAt) * 100) / 100
        }
        for (const envelope of envelopes) {
          this.queueEnvelope(envelope, metrics)
        }
      } catch (error) {
        console.warn(
          '[AgentStream] Failed to decode MessagePack envelope',
          error instanceof Error ? error.message : String(error)
        )
      }
    })
  }

  get isAttached(): boolean {
    return this.attached
  }

  subscribe(runId: string, callback: RunEventCallback): () => void {
    let handlers = this.runHandlers.get(runId)
    if (!handlers) {
      handlers = new Set()
      this.runHandlers.set(runId, handlers)
    }
    handlers.add(callback)

    return () => {
      handlers!.delete(callback)
      if (handlers!.size === 0) {
        this.runHandlers.delete(runId)
      }
    }
  }

  subscribeAll(callback: GlobalEventCallback): () => void {
    this.globalHandlers.add(callback)
    return () => {
      this.globalHandlers.delete(callback)
    }
  }

  notifySessionVisibility(sessionId: string, visible: boolean): void {
    ipcClient.send('agent:session-visibility', { sessionId, visible })
  }

  private queueEnvelope(
    envelope: AgentStreamEnvelope,
    metrics?: { byteLength: number; decodeMs: number }
  ): void {
    const previous = this.processingChains.get(envelope.runId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => this.acceptEnvelope(envelope, metrics))
      .catch((error) => {
        console.warn(
          '[AgentStream] Failed to process MessagePack envelope',
          error instanceof Error ? error.message : String(error)
        )
      })

    this.processingChains.set(envelope.runId, next)
    void next.finally(() => {
      if (this.processingChains.get(envelope.runId) === next) {
        this.processingChains.delete(envelope.runId)
      }
    })
  }

  private async acceptEnvelope(
    envelope: AgentStreamEnvelope,
    metrics?: { byteLength: number; decodeMs: number }
  ): Promise<void> {
    if (envelope.v !== AGENT_STREAM_PROTOCOL_VERSION) {
      console.warn('[AgentStream] Unknown protocol version', envelope.v)
      return
    }
    if (this.unrecoverableRunIds.has(envelope.runId)) return

    const lastSeq = this.lastSeqByRun.get(envelope.runId)
    if (lastSeq !== undefined && envelope.seq <= lastSeq) {
      return
    }

    if (lastSeq !== undefined && envelope.seq > lastSeq + 1) {
      console.warn(
        `[AgentStream] Gap detected for run ${envelope.runId}: expected ${lastSeq + 1}, got ${envelope.seq}`
      )
      const replay = await this.requestReplay(envelope.runId, lastSeq, envelope.seq - 1)
      if (replay.recoverable) {
        for (const replayedEnvelope of replay.frames) {
          if (replayedEnvelope.v !== AGENT_STREAM_PROTOCOL_VERSION) continue
          const replayedLastSeq = this.lastSeqByRun.get(replayedEnvelope.runId)
          if (replayedLastSeq !== undefined && replayedEnvelope.seq <= replayedLastSeq) continue
          this.applyEnvelope(replayedEnvelope)
        }
      } else {
        console.warn('[AgentStream] Replay unavailable', {
          runId: envelope.runId,
          afterSeq: lastSeq,
          firstAvailableSeq: replay.firstAvailableSeq,
          lastAvailableSeq: replay.lastAvailableSeq,
          reason: replay.reason
        })
        this.emitRecoveryUnavailable(envelope, lastSeq, replay)
        return
      }
    }

    const recoveredLastSeq = this.lastSeqByRun.get(envelope.runId)
    if (recoveredLastSeq !== undefined && envelope.seq <= recoveredLastSeq) return
    this.applyEnvelope(envelope, metrics)
  }

  private async requestReplay(
    runId: string,
    afterSeq: number,
    untilSeq: number
  ): Promise<AgentStreamReplayResponse> {
    try {
      return (await ipcClient.invoke('agent:stream-replay', {
        runId,
        afterSeq,
        untilSeq
      })) as AgentStreamReplayResponse
    } catch (error) {
      console.warn(
        '[AgentStream] Replay request failed',
        error instanceof Error ? error.message : String(error)
      )
      return { recoverable: false, frames: [], reason: 'not_found' }
    }
  }

  private emitRecoveryUnavailable(
    envelope: AgentStreamEnvelope,
    afterSeq: number,
    replay: AgentStreamReplayResponse
  ): void {
    this.lastSeqByRun.delete(envelope.runId)
    this.unrecoverableRunIds.add(envelope.runId)
    while (this.unrecoverableRunIds.size > 256) {
      const oldestRunId = this.unrecoverableRunIds.values().next().value
      if (!oldestRunId) break
      this.unrecoverableRunIds.delete(oldestRunId)
    }
    this.dispatch(envelope.runId, envelope.sessionId, {
      type: 'error',
      errorType: 'stream_recovery_unavailable',
      message:
        'Agent stream was interrupted and could not be recovered. The underlying run may still be active.',
      details: JSON.stringify({
        afterSeq,
        firstAvailableSeq: replay.firstAvailableSeq,
        lastAvailableSeq: replay.lastAvailableSeq,
        reason: replay.reason
      })
    })
  }

  private applyEnvelope(
    envelope: AgentStreamEnvelope,
    metrics?: { byteLength: number; decodeMs: number }
  ): void {
    this.lastSeqByRun.set(envelope.runId, envelope.seq)

    if (shouldLogMessagePackTrace()) {
      console.debug('[AgentStream] MessagePack envelope decoded', {
        runId: envelope.runId,
        sessionId: envelope.sessionId,
        seq: envelope.seq,
        events: envelope.events.length,
        ...metrics
      })
    }

    for (const event of envelope.events) {
      this.dispatch(envelope.runId, envelope.sessionId, event)
    }

    if (envelope.events.some((event) => event.type === 'loop_end' || event.type === 'error')) {
      this.lastSeqByRun.delete(envelope.runId)
    }
  }

  private dispatch(runId: string, sessionId: string, event: AgentStreamEvent): void {
    const handlers = this.runHandlers.get(runId)
    if (handlers) {
      for (const handler of handlers) {
        handler(event)
      }
    }

    for (const handler of this.globalHandlers) {
      handler(runId, sessionId, event)
    }
  }
}

export const agentStream = new AgentStreamReceiver()

function getByteLength(bytes: ArrayBuffer | ArrayBufferView): number {
  return bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.byteLength
}

function shouldLogMessagePackTrace(): boolean {
  try {
    return localStorage.getItem('openCowork.msgpackTrace') === '1'
  } catch {
    return false
  }
}
