import { parseModelSource, type ModelSource } from '../../../../shared/runtime/model-source'
import { awaitPendingSessionCreate } from '../../stores/chat-store'
import {
  parseRunSpec,
  type RunSnapshot,
  type RunStatus,
  type RunSummary,
  type RuntimeImage,
  type RuntimeTextMessage
} from '../../../../shared/runtime/contracts'
import type { ModelOptions } from '../../../../shared/runtime/model'
import { invokeMessagePackBinary } from './messagepack-ipc-client'
import { bindRunToRemoteSession } from '../remote/remote-auto-approval'
import {
  beginRemoteTaskRun,
  endRemoteTaskRun,
  publishRemoteRunEvent
} from '../remote/remote-task-progress'
import { openTsRuntimeRunStream, type TsRuntimeRunStream } from './ts-runtime-stream'
import {
  createTsRuntimeProjectionState,
  projectTsRuntimeEvents,
  projectTsRuntimeInteraction,
  isTerminalTsRuntimeStatus,
  type TsRuntimeProjectedEvent
} from './ts-runtime-projection'

/**
 * Snapshot polling is now only the degraded path: it is used when Main cannot
 * push (older runtime, `OLA_RUNTIME_PUSH=0`) and to reconcile after a resync.
 */
const POLL_INTERVAL_MS = 40

type RuntimeResult<T> = T & { error?: string }

function runtimeChannel(name: string): string {
  return `ts-runtime:${name}:msgpack`
}

const RUNTIME_INLINE_IMAGE_BYTES = 512 * 1024

function summarizeRunContractValue(value: unknown): unknown {
  if (typeof value === 'string') return { type: 'string', length: value.length }
  if (typeof value === 'number' || typeof value === 'boolean') return { type: typeof value }
  if (Array.isArray(value)) {
    const first = value[0]
    return {
      type: 'array',
      length: value.length,
      firstItemKeys:
        first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first) : undefined
    }
  }
  if (value && typeof value === 'object') return { type: 'object', keys: Object.keys(value) }
  return { type: typeof value }
}

async function stageRuntimeImages(
  workspaceId: string,
  images: readonly RuntimeImage[] | undefined
): Promise<RuntimeImage[] | undefined> {
  if (!images?.length) return images ? [] : undefined
  return await Promise.all(
    images.map(async (image) => {
      if (
        !image.data ||
        new TextEncoder().encode(image.data).byteLength <= RUNTIME_INLINE_IMAGE_BYTES
      )
        return image
      const result = await invokeMessagePackBinary<
        RuntimeResult<{ staged: boolean; assetId?: string }>
      >(runtimeChannel('asset-stage'), {
        workspaceId,
        mimeType: image.mimeType,
        base64: image.data
      })
      if (!result.staged || !result.assetId) throw new Error(result.error ?? 'RUNTIME_ASSET_FAILED')
      return { mimeType: image.mimeType, assetId: result.assetId }
    })
  )
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
  businessTaskId?: string
  /** Stable chat message target retained in the runtime journal for reattach. */
  assistantMessageId?: string
  channelContext?: { pluginId: string; chatId: string; messageId?: string }
  teamContext?: { teamName: string; memberName?: string }
  modelSource: ModelSource
  modelOptions?: ModelOptions
  prompt: string
  promptImages?: RuntimeImage[]
  history?: RuntimeTextMessage[]
  environmentId?: string
  workingDirectory?: string
  sshConnectionId?: string
  extensionIds?: string[]
  translationContext?: {
    sourceLanguage: string
    targetLanguage: string
    fileRoot?: string
  }
  /** Explicit model-visible capability snapshot; omitted means no tools. */
  toolNames?: string[]
  maxTurns?: number
  maxToolCalls?: number
  imageModelSource?: ModelSource
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

/** Cancels one authorized TS runtime run, including nested team workers. */
export async function cancelTsRuntimeRun(input: {
  workspaceId: string
  runId: string
}): Promise<boolean> {
  const result = await invokeMessagePackBinary<RuntimeResult<{ cancelled: boolean }>>(
    runtimeChannel('run-cancel'),
    input
  )
  if (result.error) throw new Error(result.error)
  return result.cancelled === true
}

/**
 * This bridge carries text turns, bounded image content and an explicit,
 * compatibility-proven tool snapshot. Oversized or richer attachments remain
 * on the legacy path. SSH turns carry only a connection id and are still
 * subject to Main-side workspace authorization; channel turns require an
 * explicit channel context and unattended authorization.
 */
export async function* streamTsRuntimeTextTurn(
  input: TsRuntimeTextTurn
): AsyncGenerator<TsRuntimeProjectedEvent> {
  const source = parseModelSource(input.modelSource)
  const promptImages = await stageRuntimeImages(input.workspaceId, input.promptImages)
  const history = input.history
    ? await Promise.all(
        input.history.map(async (message) => ({
          ...message,
          ...(message.images
            ? { images: await stageRuntimeImages(input.workspaceId, message.images) }
            : {})
        }))
      )
    : undefined
  const runInput = {
    runId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    ...(input.businessTaskId ? { businessTaskId: input.businessTaskId } : {}),
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    sessionId: input.sessionId,
    ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
    ...(input.channelContext ? { channelContext: input.channelContext } : {}),
    ...(input.teamContext ? { teamContext: input.teamContext } : {}),
    workspaceId: input.workspaceId,
    environmentId: input.environmentId ?? 'local',
    ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    ...(input.sshConnectionId ? { sshConnectionId: input.sshConnectionId } : {}),
    ...(input.extensionIds?.length ? { extensionIds: input.extensionIds } : {}),
    ...(input.translationContext ? { translationContext: input.translationContext } : {}),
    ...(input.toolNames?.length ? { toolNames: input.toolNames } : {}),
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    ...(input.maxToolCalls !== undefined ? { maxToolCalls: input.maxToolCalls } : {}),
    modelSource: source,
    ...(input.imageModelSource
      ? { imageModelSource: parseModelSource(input.imageModelSource) }
      : {}),
    ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
    prompt: input.prompt,
    ...(promptImages?.length ? { promptImages } : {}),
    ...(history?.length ? { history } : {}),
    unattended: input.unattended ?? false
  }
  let run: ReturnType<typeof parseRunSpec>
  try {
    run = parseRunSpec(runInput)
  } catch (error) {
    const requiredFields = [
      'runId',
      'taskId',
      'requestId',
      'traceId',
      'sessionId',
      'workspaceId',
      'environmentId',
      'modelSource',
      'prompt',
      'unattended'
    ]
    const requiredInput = Object.fromEntries(
      requiredFields.map((key) => [key, runInput[key as keyof typeof runInput]])
    )
    const invalidFields: string[] = []
    try {
      parseRunSpec(requiredInput)
      for (const [field, value] of Object.entries(runInput)) {
        if (requiredFields.includes(field)) continue
        try {
          parseRunSpec({ ...requiredInput, [field]: value })
        } catch {
          invalidFields.push(field)
        }
      }
    } catch {
      invalidFields.push('required-contract')
    }
    console.error(
      '[TS Runtime] Run contract validation failed; values redacted',
      JSON.stringify({
        invalidFields,
        fields: Object.fromEntries(
          Object.entries(runInput).map(([key, value]) => [key, summarizeRunContractValue(value)])
        )
      })
    )
    throw error
  }
  let submitted = false
  let lastSeq = 0
  const projectionState = createTsRuntimeProjectionState()
  const emittedInteractions = new Set<string>()
  /**
   * Interactions are not part of the event stream, so a snapshot is the only
   * way to learn about them. Applying a snapshot is idempotent: events are
   * filtered by `lastSeq` and interactions by `emittedInteractions`.
   */
  const applySnapshot = (
    snapshot: RunSnapshot
  ): { projected: TsRuntimeProjectedEvent[]; terminal: boolean } => {
    const events = snapshot.events.filter((event) => event.seq > lastSeq)
    for (const event of events) {
      lastSeq = Math.max(lastSeq, event.seq)
      // Replayed events carry the same weight as pushed ones for a controller.
      publishRemoteRunEvent(run.runId, event)
    }
    const projected = projectTsRuntimeEvents(events, projectionState)
    for (const interaction of snapshot.pendingInteractions) {
      const key = `${interaction.runId}:${interaction.interactionId}`
      if (emittedInteractions.has(key)) continue
      emittedInteractions.add(key)
      projected.push(projectTsRuntimeInteraction(interaction))
    }
    return { projected, terminal: isTerminalTsRuntimeStatus(snapshot.run.status) }
  }
  const readSnapshot = async (): Promise<RunSnapshot> => {
    const response = await invokeMessagePackBinary<RuntimeResult<{ snapshot: RunSnapshot | null }>>(
      runtimeChannel('run-snapshot'),
      {
        workspaceId: run.workspaceId,
        runId: run.runId,
        afterSeq: lastSeq
      }
    )
    if (response.error) throw new Error(response.error)
    if (!response.snapshot) throw new Error('RUN_NOT_FOUND')
    return response.snapshot
  }
  let stream: TsRuntimeRunStream | null = null
  const subscribe = (afterSeq: number): Promise<TsRuntimeRunStream | null> =>
    openTsRuntimeRunStream({
      workspaceId: run.workspaceId,
      runId: run.runId,
      afterSeq,
      signal: input.signal
    }).catch(() => null)
  try {
    await awaitPendingSessionCreate(run.sessionId)
    const result = await invokeMessagePackBinary<RuntimeResult<{ accepted: boolean }>>(
      runtimeChannel('run-submit'),
      run
    )
    if (!result.accepted) throw new Error(result.error ?? 'TS_RUNTIME_UNAVAILABLE')
    submitted = true
    input.onRunIdAssigned?.(run.runId)
    // Tell the main process this run exists while the remote session is open.
    // Only bound runs may have their approvals decided automatically; a run
    // started before the session never gets a binding, so a controller cannot
    // inherit a decision the local user made for their own work.
    void bindRunToRemoteSession(run.runId)
    // Mirror the run into the projection a controller reads. Registered before
    // the first snapshot so a controller that connects immediately sees the
    // prompt instead of an empty task.
    //
    // Only runs that fill a visible assistant message are projected. The same
    // pipeline also drives auxiliary work — the post-run outcome summary, title
    // generation, translation — and those runs must not take the panel over:
    // that would wipe the steps a controller is reading the moment the task
    // finishes, which is exactly when they are worth reading.
    if (run.assistantMessageId) {
      beginRemoteTaskRun(
        run.runId,
        typeof run.prompt === 'string' ? run.prompt : '',
        run.sessionId,
        input.workingDirectory
      )
    }
    // Subscribe before the first snapshot so an event committed between the
    // two is buffered by the runtime instead of being missed.
    stream = await subscribe(0)
    const initial = stream ? applySnapshot(stream.snapshot) : null
    if (initial) {
      yield* initial.projected
      if (initial.terminal) return
    }
    /**
     * Set when the caller owes one snapshot reconciliation. A subscription that
     * cannot be opened — push unsupported, IPC rejected, or the open timed out —
     * leaves `stream` null, which turns the loop into the previous 40 ms poll.
     * Throwing here would abort a run whose events are still readable by polling.
     */
    let reconcile = !stream
    for (;;) {
      if (input.signal?.aborted) throw new Error('aborted')
      if (reconcile) {
        const applied = applySnapshot(await readSnapshot())
        yield* applied.projected
        if (applied.terminal) return
        reconcile = false
      }
      if (!stream) {
        await pause(input.signal)
        reconcile = true
        continue
      }
      const item = await stream.next()
      if (item.kind === 'end') {
        // A local close ends the turn; anything committed just before it has
        // already been delivered or will be dropped with the renderer.
        if (input.signal?.aborted) throw new Error('aborted')
        return
      }
      if (item.kind === 'resync') {
        // The runtime dropped the subscription. Reopen from the last delivered
        // sequence, or keep polling if this Main process cannot resubscribe.
        await stream.close()
        stream = await subscribe(lastSeq).catch(() => null)
        if (stream) yield* applySnapshot(stream.snapshot).projected
        reconcile = true
        continue
      }
      const event = item.event
      if (event.seq <= lastSeq) continue
      if (event.seq !== lastSeq + 1) {
        // A hole means the stream is no longer trustworthy; the journal is.
        reconcile = true
        continue
      }
      lastSeq = event.seq
      publishRemoteRunEvent(run.runId, event)
      yield* projectTsRuntimeEvents([event], projectionState)
      const data = event.data as { status?: unknown } | null
      if (event.type !== 'run.status' || typeof data?.status !== 'string') continue
      if (isTerminalTsRuntimeStatus(data.status as RunStatus)) return
      // A run that starts waiting for an answer published no interaction event;
      // read the pending set once, then go back to waiting for pushes.
      if (data.status === 'waiting_interaction') reconcile = true
    }
  } finally {
    await stream?.close()
    // Tell a watching controller that the run stopped even when the runtime
    // never published a terminal status (aborted turn, dropped stream).
    endRemoteTaskRun(run.runId, input.signal?.aborted ? 'cancelled' : 'interrupted')
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
