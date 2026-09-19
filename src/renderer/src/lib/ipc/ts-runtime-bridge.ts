import { parseModelSource, type ModelSource } from '../../../../shared/runtime/model-source'
import { awaitPendingSessionCreate } from '../../stores/chat-store'
import {
  parseRunSpec,
  type RunSnapshot,
  type RunSummary,
  type RuntimeTextMessage
} from '../../../../shared/runtime/contracts'
import type { ModelOptions } from '../../../../shared/runtime/model'
import { invokeMessagePackBinary } from './messagepack-ipc-client'
import {
  createTsRuntimeProjectionState,
  projectTsRuntimeEvents,
  projectTsRuntimeInteraction,
  isTerminalTsRuntimeStatus,
  type TsRuntimeProjectedEvent
} from './ts-runtime-projection'

const POLL_INTERVAL_MS = 40

type RuntimeResult<T> = T & { error?: string }

function runtimeChannel(name: string): string {
  return `ts-runtime:${name}:msgpack`
}

async function pause(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('aborted')
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, POLL_INTERVAL_MS)
    function done(): void {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    function abort(): void {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export interface TsRuntimeTextTurn {
  workspaceId: string
  sessionId: string
  /** Stable chat message target retained in the runtime journal for reattach. */
  assistantMessageId?: string
  channelContext?: { pluginId: string; chatId: string; messageId?: string }
  modelSource: ModelSource
  modelOptions?: ModelOptions
  prompt: string
  history?: RuntimeTextMessage[]
  environmentId?: string
  workingDirectory?: string
  extensionIds?: string[]
  /** Explicit model-visible capability snapshot; omitted means no tools. */
  toolNames?: string[]
  maxTurns?: number
  maxToolCalls?: number
  unattended?: boolean
  onRunIdAssigned?: (runId: string) => void
  signal?: AbortSignal
}

export async function isTsRuntimeAvailable(): Promise<boolean> {
  try {
    const status = await invokeMessagePackBinary<RuntimeResult<{ available: boolean }>>(
      runtimeChannel('status'),
      undefined
    )
    return status.available === true
  } catch {
    return false
  }
}

/** Lists public operational metadata for one authorized workspace. */
export async function listTsRuntimeRuns(workspaceId: string): Promise<RunSummary[]> {
  const result = await invokeMessagePackBinary<RuntimeResult<{ runs: RunSummary[] }>>(
    runtimeChannel('runs-list'),
    { workspaceId }
  )
  if (result.error) throw new Error(result.error)
  return Array.isArray(result.runs) ? result.runs : []
}

/** Reads persisted events after a caller-owned sequence cursor. */
export async function getTsRuntimeRunSnapshot(input: {
  workspaceId: string
  runId: string
  afterSeq: number
}): Promise<RunSnapshot | null> {
  const result = await invokeMessagePackBinary<RuntimeResult<{ snapshot: RunSnapshot | null }>>(
    runtimeChannel('run-snapshot'),
    input
  )
  if (result.error) throw new Error(result.error)
  return result.snapshot ?? null
}

export async function requestTsRuntimeWorkspaceSwitch(
  workspaceId: string,
  fromWorkspaceId: string
): Promise<void> {
  const result = await invokeMessagePackBinary<RuntimeResult<{ switched: boolean }>>(
    runtimeChannel('workspace-switch'),
    { workspaceId, fromWorkspaceId }
  )
  if (!result.switched) throw new Error(result.error ?? 'TS_RUNTIME_WORKSPACE_SWITCH_REJECTED')
}

export async function respondTsRuntimeInteraction(input: {
  workspaceId: string
  runId: string
  interactionId: string
  response: unknown
}): Promise<void> {
  const result = await invokeMessagePackBinary<RuntimeResult<{ accepted: boolean }>>(
    runtimeChannel('run-interact'),
    input
  )
  if (!result.accepted) throw new Error(result.error ?? 'TS_RUNTIME_INTERACTION_REJECTED')
}

/**
 * This bridge carries text turns plus an explicit, compatibility-proven tool
 * snapshot. Callers must prove equivalence first; unsupported attachments,
 * plans, SSH and plugin turns stay on their legacy path.
 */
export async function* streamTsRuntimeTextTurn(
  input: TsRuntimeTextTurn
): AsyncGenerator<TsRuntimeProjectedEvent> {
  const source = parseModelSource(input.modelSource)
  const run = parseRunSpec({
    runId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    sessionId: input.sessionId,
    ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
    ...(input.channelContext ? { channelContext: input.channelContext } : {}),
    workspaceId: input.workspaceId,
    environmentId: input.environmentId ?? 'local',
    ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    ...(input.extensionIds?.length ? { extensionIds: input.extensionIds } : {}),
    ...(input.toolNames?.length ? { toolNames: input.toolNames } : {}),
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    ...(input.maxToolCalls !== undefined ? { maxToolCalls: input.maxToolCalls } : {}),
    modelSource: source,
    ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
    prompt: input.prompt,
    ...(input.history?.length ? { history: input.history } : {}),
    unattended: input.unattended ?? false
  })
  let submitted = false
  let afterSeq = 0
  const projectionState = createTsRuntimeProjectionState()
  const emittedInteractions = new Set<string>()
  try {
    await awaitPendingSessionCreate(run.sessionId)
    const result = await invokeMessagePackBinary<RuntimeResult<{ accepted: boolean }>>(
      runtimeChannel('run-submit'),
      run
    )
    if (!result.accepted) throw new Error(result.error ?? 'TS_RUNTIME_UNAVAILABLE')
    submitted = true
    input.onRunIdAssigned?.(run.runId)
    for (;;) {
      if (input.signal?.aborted) throw new Error('aborted')
      const response = await invokeMessagePackBinary<
        RuntimeResult<{ snapshot: RunSnapshot | null }>
      >(runtimeChannel('run-snapshot'), {
        workspaceId: run.workspaceId,
        runId: run.runId,
        afterSeq
      })
      if (response.error) throw new Error(response.error)
      if (!response.snapshot) throw new Error('RUN_NOT_FOUND')
      for (const event of response.snapshot.events) {
        afterSeq = Math.max(afterSeq, event.seq)
        yield* projectTsRuntimeEvents([event], projectionState)
      }
      for (const interaction of response.snapshot.pendingInteractions) {
        const key = `${interaction.runId}:${interaction.interactionId}`
        if (emittedInteractions.has(key)) continue
        emittedInteractions.add(key)
        yield projectTsRuntimeInteraction(interaction)
      }
      if (isTerminalTsRuntimeStatus(response.snapshot.run.status)) return
      await pause(input.signal)
    }
  } finally {
    if (submitted && input.signal?.aborted) {
      await invokeMessagePackBinary<RuntimeResult<{ cancelled: boolean }>>(
        runtimeChannel('run-cancel'),
        {
          workspaceId: run.workspaceId,
          runId: run.runId
        }
      ).catch(() => undefined)
    }
  }
}
