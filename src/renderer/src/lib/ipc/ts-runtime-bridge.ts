import { parseModelSource, type ModelSource } from '../../../../shared/runtime/model-source'
import { awaitPendingSessionCreate } from '../../stores/chat-store'
import {
  parseRunSpec,
  type RunSnapshot,
  type RunSummary,
  type RuntimeImage,
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
