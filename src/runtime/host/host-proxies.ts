import { randomUUID } from 'node:crypto'
import { RuntimeError, type RunSpec } from '../../shared/runtime/contracts'
import type {
  HostProviderStreamParams,
  HostStreamFrame,
  HostToolCatalogResult,
  HostToolExecuteResult
} from '../../shared/runtime/host-protocol'
import type { ModelDelta, ModelInput, ProviderAdapter } from '../../shared/runtime/model'
import type { AgentToolExecutor } from '../tools/tool-executor'
import type { RuntimeHostChannel } from './standalone'

/**
 * A model turn produces deltas faster than the journal commits them, so the
 * consumer pulls from this buffer. The bound is a runaway guard, not flow
 * control: a generator that stops being pulled must not grow without limit.
 */
const MAX_BUFFERED_DELTAS = 4096

class DeltaBuffer {
  private deltas: ModelDelta[] = []
  private failure: Error | null = null
  private ended = false
  private wake: (() => void) | null = null

  push(frame: HostStreamFrame): void {
    if (this.ended || this.failure) return
    if (typeof frame.error === 'string') this.failure = new RuntimeError(frame.error)
    else if (frame.delta) {
      if (this.deltas.length >= MAX_BUFFERED_DELTAS) {
        this.failure = new RuntimeError('HOST_STREAM_OVERFLOW')
        return
      }
      this.deltas.push(frame.delta)
    }
    if (frame.end || this.failure) this.ended = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ModelDelta> {
    while (true) {
      while (this.deltas.length) yield this.deltas.shift()!
      if (this.failure) throw this.failure
      if (this.ended) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = null
    }
  }
}

export interface HostProviderAdapter extends ProviderAdapter {
  /** Drops the conversation cursor for a run that has finished. */
  forget(runId: string): void
}

/**
 * Main owns provider credentials, so the model request runs there and only
 * semantic deltas cross the socket. Later turns send just the messages the
 * agent appended: resending a long history every turn would be pure waste.
 */
export function createHostProviderAdapter(host: RuntimeHostChannel): HostProviderAdapter {
  const sent = new Map<string, number>()
  return {
    forget: (runId) => {
      sent.delete(runId)
    },
    stream: async function* (input: ModelInput): AsyncIterableIterator<ModelDelta> {
      const streamId = randomUUID()
      const buffer = new DeltaBuffer()
      const dispose = host.registerHostStream(streamId, { onDelta: (frame) => buffer.push(frame) })
      const cancel = (): void => {
        void host.requestHost('provider.stream.cancel', { streamId }).catch(() => undefined)
      }
      input.signal.addEventListener('abort', cancel, { once: true })
      const alreadySent = sent.get(input.run.runId) ?? 0
      const params: HostProviderStreamParams = {
        streamId,
        runId: input.run.runId,
        messages: input.messages.slice(alreadySent),
        tools: input.tools,
        reset: alreadySent === 0,
        ...(alreadySent === 0 ? { run: input.run } : {})
      }
      try {
        await host.requestHost('provider.stream', params)
        sent.set(input.run.runId, input.messages.length)
        for await (const delta of buffer) {
          input.signal.throwIfAborted()
          yield delta
        }
        // Main closes the stream when it aborts, so a cancelled turn must not
        // look like a finished one to the agent loop.
        input.signal.throwIfAborted()
      } finally {
        dispose()
        input.signal.removeEventListener('abort', cancel)
        if (input.signal.aborted) cancel()
      }
    }
  }
}

/**
 * Only the catalog and the batch result cross the socket. Validation, policy
 * hooks, approval, resource locks and artifact derivation all stay in Main,
 * which reports progress back through the run's own journal.
 */
export function createHostToolResolver(
  host: RuntimeHostChannel
): (run: RunSpec) => Promise<AgentToolExecutor> {
  return async (run) => {
    const { tools } = await host.requestHost<HostToolCatalogResult>(
      'tool.catalog',
      { run },
      120_000
    )
    return {
      catalog: () => tools,
      executeAll: async (calls, context) => {
        const abort = (): void => {
          void host.requestHost('tool.abort', { runId: run.runId }).catch(() => undefined)
        }
        context.signal.addEventListener('abort', abort, { once: true })
        try {
          const { results } = await host.requestHost<HostToolExecuteResult>(
            'tool.execute',
            { runId: run.runId, calls },
            0
          )
          return results
        } finally {
          context.signal.removeEventListener('abort', abort)
        }
      }
    }
  }
}
