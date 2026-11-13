import {
  RuntimeError,
  TERMINAL_STATUSES,
  type RunRecord,
  type RunSnapshot,
  type RunSpec
} from '../../shared/runtime/contracts'
import type {
  HostProviderStreamParams,
  HostRunInteractionParams,
  HostRunKeyParams,
  HostToolCatalogResult,
  HostToolExecuteParams,
  HostWorkspaceAuthorityResult
} from '../../shared/runtime/host-protocol'
import type { AgentMessage, ProviderAdapter } from '../../shared/runtime/model'
import type { RuntimeClient } from '../../runtime/host/runtime-client'
import type { ToolContext, ToolExecutor } from '../../runtime/tools/tool-executor'

/**
 * A run's Main-side state lives only while the child is executing it. The child
 * releases it explicitly, and a lost host connection drops everything, so a
 * crashed runtime cannot leave credentials-bearing entries behind.
 */
const MAX_TRACKED_RUNS = 64
const NESTED_POLL_MS = 40

interface TrackedRun {
  run: RunSpec
  executor: ToolExecutor
  controllers: Set<AbortController>
  messages: AgentMessage[]
}

export interface RuntimeHostBridgeOptions {
  client: RuntimeClient
  authorize: (run: RunSpec) => Promise<void>
  provider: ProviderAdapter
  tools: (run: RunSpec) => Promise<ToolExecutor>
  workspaceIds: () => Promise<ReadonlySet<string>>
}

export interface RuntimeHostBridge {
  handle: (method: string, params: unknown) => Promise<unknown>
  /** Called when the runtime connection is gone; nothing may survive it. */
  reset: () => void
}

function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string')
    return (error as { code: string }).code
  return 'REQUEST_FAILED'
}

function params<T>(value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_REQUEST')
  return value as T
}

/**
 * Serves the capabilities the isolated runtime must not own. Provider keys,
 * desktop DAOs, policy hooks and the approval policy never leave Main: the child
 * receives a tool catalog, semantic model deltas and batch results only.
 */
export function createRuntimeHostBridge(options: RuntimeHostBridgeOptions): RuntimeHostBridge {
  const runs = new Map<string, TrackedRun>()
  const streams = new Map<string, AbortController>()

  const tracked = (runId: string): TrackedRun => {
    const entry = runs.get(runId)
    if (!entry) throw new RuntimeError('RUN_NOT_FOUND')
    return entry
  }

  const release = (runId: string): void => {
    const entry = runs.get(runId)
    if (!entry) return
    for (const controller of entry.controllers) controller.abort(new RuntimeError('RUN_CANCELLED'))
    runs.delete(runId)
  }

  const reset = (): void => {
    for (const runId of [...runs.keys()]) release(runId)
    for (const controller of streams.values()) controller.abort(new RuntimeError('RUN_CANCELLED'))
    streams.clear()
  }

  const record = async (run: RunSpec, type: string, data: unknown): Promise<void> => {
    await options.client.request(
      'host.run.record',
      { workspaceId: run.workspaceId, runId: run.runId, type, data },
      30_000
    )
  }

  const submitNested = async (run: RunSpec, input: unknown): Promise<RunRecord> =>
    await options.client.request<RunRecord>(
      'host.run.submit-nested',
      { workspaceId: run.workspaceId, spec: input },
      30_000
    )

  /**
   * The child cannot see Main's AbortSignal, so cancellation is an explicit
   * `run.cancel`. Knowing the child's id before waiting is what makes that
   * possible, which is why submission and waiting are separate steps.
   */
  const awaitNested = async (child: RunRecord, signal: AbortSignal): Promise<RunSnapshot> => {
    let afterSeq = 0
    while (true) {
      if (signal.aborted) {
        await options.client
          .request('run.cancel', { workspaceId: child.workspaceId, runId: child.runId })
          .catch(() => undefined)
        throw signal.reason ?? new RuntimeError('RUN_CANCELLED')
      }
      const snapshot = await options.client.request<RunSnapshot | null>('run.snapshot', {
        workspaceId: child.workspaceId,
        runId: child.runId,
        afterSeq
      })
      if (!snapshot) throw new RuntimeError('RUN_NOT_FOUND')
      if (TERMINAL_STATUSES.has(snapshot.run.status)) return snapshot
      afterSeq = snapshot.run.seq
      await new Promise((resolve) => setTimeout(resolve, NESTED_POLL_MS))
    }
  }

  const toolContext = (entry: TrackedRun, controller: AbortController): ToolContext => ({
    run: entry.run,
    signal: controller.signal,
    requestInteraction: async (interaction) => {
      const request: HostRunInteractionParams = {
        workspaceId: entry.run.workspaceId,
        runId: entry.run.runId,
        interaction
      }
      // A human approval has no deadline; only cancellation or a lost runtime ends it.
      const answer = await options.client.request<{ response: unknown }>(
        'host.run.interaction',
        request,
        0
      )
      return answer.response
    },
    runNested: async (input) =>
      awaitNested(await submitNested(entry.run, input), controller.signal),
    submitNested: async (input, onTerminal) => {
      const child = await submitNested(entry.run, input)
      if (onTerminal) void awaitNested(child, controller.signal).then(onTerminal, () => undefined)
      return child
    }
  })

  const startStream = (input: HostProviderStreamParams): { ok: true } => {
    const { streamId, runId, messages, tools, reset: restarting, run } = input
    if (typeof streamId !== 'string' || !streamId) throw new RuntimeError('INVALID_REQUEST')
    if (streams.has(streamId)) throw new RuntimeError('INVALID_REQUEST')
    const entry = tracked(runId)
    if (restarting) {
      if (!run || run.runId !== runId) throw new RuntimeError('INVALID_REQUEST')
      entry.messages = [...messages]
    } else {
      entry.messages = [...entry.messages, ...messages]
    }
    const controller = new AbortController()
    streams.set(streamId, controller)
    const conversation = entry.messages
    void (async () => {
      try {
        for await (const delta of options.provider.stream({
          run: entry.run,
          messages: conversation,
          tools,
          signal: controller.signal
        })) {
          if (controller.signal.aborted) break
          options.client.sendHostStream({ streamId, delta })
        }
        options.client.sendHostStream({ streamId, end: true })
      } catch (error) {
        options.client.sendHostStream({ streamId, end: true, error: failureCode(error) })
      } finally {
        streams.delete(streamId)
      }
    })()
    return { ok: true }
  }

  return {
    reset,
    handle: async (method, raw) => {
      switch (method) {
        case 'authorize': {
          const { run } = params<{ run: RunSpec }>(raw)
          await options.authorize(run)
          return null
        }
        case 'workspace.authority': {
          const result: HostWorkspaceAuthorityResult = {
            workspaceIds: [...(await options.workspaceIds())]
          }
          return result
        }
        case 'tool.catalog': {
          const { run } = params<{ run: RunSpec }>(raw)
          if (runs.size >= MAX_TRACKED_RUNS && !runs.has(run.runId))
            throw new RuntimeError('TOO_MANY_REQUESTS')
          const executor = await options.tools(run)
          runs.set(run.runId, { run, executor, controllers: new Set(), messages: [] })
          const result: HostToolCatalogResult = { tools: executor.catalog() }
          return result
        }
        case 'tool.execute': {
          const { runId, calls } = params<HostToolExecuteParams>(raw)
          const entry = tracked(runId)
          const controller = new AbortController()
          entry.controllers.add(controller)
          try {
            const results = await entry.executor.executeAll(
              calls,
              toolContext(entry, controller),
              (type, data) => record(entry.run, type, data)
            )
            return { results }
          } finally {
            entry.controllers.delete(controller)
          }
        }
        case 'tool.abort': {
          const { runId } = params<HostRunKeyParams>(raw)
          const entry = runs.get(runId)
          for (const controller of entry?.controllers ?? [])
            controller.abort(new RuntimeError('RUN_CANCELLED'))
          return { ok: true }
        }
        case 'tool.release': {
          const { runId } = params<HostRunKeyParams>(raw)
          release(runId)
          return { ok: true }
        }
        case 'provider.stream':
          return startStream(params<HostProviderStreamParams>(raw))
        case 'provider.stream.cancel': {
          const { streamId } = params<{ streamId: string }>(raw)
          streams.get(streamId)?.abort(new RuntimeError('RUN_CANCELLED'))
          streams.delete(streamId)
          return { ok: true }
        }
        default:
          throw new RuntimeError('UNKNOWN_METHOD')
      }
    }
  }
}
