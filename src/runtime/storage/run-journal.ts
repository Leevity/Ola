import { Worker } from 'node:worker_threads'
import {
  RuntimeError,
  type RunSpec,
  type RunRecord,
  type RunSummary,
  type RunEvent,
  type RunStatus,
  type RunSnapshot,
  type PendingRuntimeInteraction
} from '../../shared/runtime/contracts'
import type { ExecutionPageKey } from '../../shared/execution-record'

function journalWorkerUrl(): URL {
  // electron-vite clears out/main before every development rebuild. Its dynamic
  // Worker URL cannot be part of Vite's dependency graph, so use the source
  // pair while Electron runs as the default development app. Production and
  // CLI builds keep resolving the explicitly copied sibling asset.
  if ((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp)
    return new URL('../../src/runtime/storage/journal-worker.mjs', import.meta.url)
  return new URL('./journal-worker.mjs', import.meta.url)
}

/** This journal owns only runtime-v2 data. Legacy application databases remain untouched. */
export class RunJournal {
  private worker: Worker
  private sequence = 0
  private failure: Error | null = null
  private closing = false
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  constructor(path: string) {
    this.worker = new Worker(journalWorkerUrl(), {
      workerData: { path }
    })
    this.worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const request = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) request?.reject(new RuntimeError(message.error))
      else request?.resolve(message.result)
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', () => this.fail(new RuntimeError('JOURNAL_CLOSED')))
  }
  private fail(error: Error): void {
    this.failure = error
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
  private call<T>(method: string, args: unknown = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closing && method !== 'close')
      return Promise.reject(new RuntimeError('JOURNAL_CLOSED'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.worker.postMessage({ id, method, args })
    })
  }
  recordExternalArtifact(
    spec: RunSpec,
    artifact: { path: string; mediaType: string }
  ): Promise<void> {
    return this.call('external-artifact', { spec, artifact })
  }
  create(spec: RunSpec): Promise<{ run: RunRecord; created: boolean }> {
    return this.call('create', { spec })
  }
  append(runId: string, workspaceId: string, type: string, data: unknown): Promise<RunEvent> {
    return this.call('append', { runId, workspaceId, type, data })
  }
  transition(
    runId: string,
    workspaceId: string,
    from: RunStatus[],
    status: RunStatus,
    reason?: string
  ): Promise<RunEvent | null> {
    return this.call('transition', { runId, workspaceId, from, status, reason })
  }
  snapshot(
    runId: string,
    workspaceId: string,
    afterSeq = 0,
    limit = 256
  ): Promise<RunSnapshot | null> {
    return this.call('snapshot', {
      runId,
      workspaceId,
      afterSeq: Math.max(0, Math.trunc(afterSeq)),
      limit: Math.min(1000, Math.max(1, Math.trunc(limit)))
    })
  }
  list(
    workspaceId: string,
    limit = 100,
    offset = 0,
    attentionOnly = false,
    anchor?: ExecutionPageKey,
    after?: ExecutionPageKey
  ): Promise<RunSummary[]> {
    return this.call('list', {
      workspaceId,
      limit: Math.min(1000, Math.max(1, Math.trunc(limit))),
      offset: Math.max(0, Math.trunc(offset)),
      attentionOnly,
      anchor,
      after
    })
  }
  artifacts(
    workspaceId: string,
    limit = 50,
    offset = 0,
    runId?: string
  ): Promise<
    Array<{
      runId: string
      seq: number
      data: unknown
      timestamp: number
      sessionId: string
      status: RunStatus
      projectId: string | null
      workingDirectory: string | null
    }>
  > {
    return this.call('artifacts-list', {
      workspaceId,
      limit: Math.min(200, Math.max(1, Math.trunc(limit))),
      offset: Math.max(0, Math.trunc(offset)),
      runId
    })
  }
  hideArtifact(workspaceId: string, runId: string, seq: number): Promise<{ hidden: true }> {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new RuntimeError('INVALID_ARTIFACT_ID')
    return this.call('artifact-hide', { workspaceId, runId, seq })
  }
  active(): Promise<RunRecord[]> {
    return this.call('active')
  }
  recover(): Promise<RunEvent[]> {
    return this.call('recover')
  }
  createInteraction(
    runId: string,
    workspaceId: string,
    interaction: Omit<PendingRuntimeInteraction, 'runId' | 'workspaceId' | 'createdAt'>
  ): Promise<PendingRuntimeInteraction> {
    return this.call('interaction-create', { runId, workspaceId, interaction })
  }
  resolveInteraction(
    runId: string,
    workspaceId: string,
    interactionId: string,
    response: unknown
  ): Promise<{ interaction: PendingRuntimeInteraction; event: RunEvent }> {
    return this.call('interaction-resolve', { runId, workspaceId, interactionId, response })
  }
  abandonInteractions(
    runId: string,
    workspaceId: string,
    reason: string
  ): Promise<RunEvent | null> {
    return this.call('interaction-abandon', { runId, workspaceId, reason })
  }
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    try {
      await this.call('close')
    } finally {
      await this.worker.terminate()
    }
  }
}
