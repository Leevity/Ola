import {
  RuntimeError,
  type PendingRuntimeInteraction,
  type RunSpec
} from '../../shared/runtime/contracts'

import type {
  ModelToolCall as ToolCall,
  ModelToolResult as ToolResult
} from '../../shared/runtime/model'
import type { RunSnapshot } from '../../shared/runtime/contracts'
import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
export type {
  ModelToolCall as ToolCall,
  ModelToolResult as ToolResult
} from '../../shared/runtime/model'

export interface ToolContext {
  run: RunSpec
  /** Host-provided stable identity for this tool call, used by side-effect ledgers. */
  toolCallId?: string
  signal: AbortSignal
  /** Supplied only by the scheduler-backed agent path, never by a tool itself. */
  requestInteraction?: (
    interaction: Omit<PendingRuntimeInteraction, 'runId' | 'workspaceId' | 'createdAt'>
  ) => Promise<unknown>
  runNested?: (input: unknown) => Promise<RunSnapshot>
  submitNested?: (
    input: unknown,
    onTerminal?: (snapshot: RunSnapshot) => Promise<void>
  ) => Promise<import('../../shared/runtime/contracts').RunRecord>
}
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  effect: 'read' | 'write'
  /** Serialize stateful reads, such as inspecting one shared Browser tab. */
  serializeReads?: boolean
  validate: (input: unknown) => unknown
  /** Canonical resource ids come from the host, never directly from model arguments. */
  resources: (input: unknown, context: ToolContext) => Promise<string[]>
  execute: (input: unknown, context: ToolContext) => Promise<unknown>
  /** Optional host-owned result extraction for non-local resources such as SSH. */
  artifacts?: (
    output: unknown,
    context: ToolContext
  ) => Promise<
    Array<
      | {
          kind: 'file'
          transport: 'ssh'
          connectionId: string
          path: string
          operation: 'create' | 'modify'
        }
      | {
          kind: 'file'
          transport: 'local'
          path: string
          operation: 'create' | 'modify'
          mediaType?: string
        }
      | { kind: 'link'; transport: 'remote'; url: string; title: string }
    >
  >
}

const RUNTIME_TOOL_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function parseRuntimeToolImageOutput(value: unknown): {
  text: string
  images: Array<{ mimeType: string; assetId: string }>
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const image = record.__runtimeToolImage
  if (!image || typeof image !== 'object' || Array.isArray(image)) return null
  const asset = image as Record<string, unknown>
  if (
    typeof record.text !== 'string' ||
    typeof asset.mimeType !== 'string' ||
    !RUNTIME_TOOL_IMAGE_MIMES.has(asset.mimeType) ||
    typeof asset.assetId !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(asset.assetId)
  )
    throw new RuntimeError('INVALID_RUNTIME_TOOL_IMAGE')
  return {
    text: record.text.slice(0, 16_384),
    images: [{ mimeType: asset.mimeType, assetId: asset.assetId }]
  }
}

async function confirmedFileArtifacts(
  name: string,
  output: unknown,
  resources: string[]
): Promise<Array<{ path: string; operation: 'create' | 'modify'; mediaType?: string }>> {
  if (name === 'ImageGenerate') {
    if (typeof output !== 'string' || output.length > 32_768 || !resources[0]) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(output)
    } catch {
      return []
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const imageResult = parsed as Record<string, unknown>
    if (
      imageResult.__olaImageResult !== true ||
      !Array.isArray(imageResult.images) ||
      imageResult.images.length > 4
    )
      return []
    const images: Array<{ path: string; operation: 'create'; mediaType: string }> = []
    for (const entry of imageResult.images) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const image = entry as Record<string, unknown>
      if (
        typeof image.filePath !== 'string' ||
        !isAbsolute(image.filePath) ||
        image.mediaType !== 'image/png'
      )
        continue
      const pathWithinRoot = relative(resources[0], image.filePath)
      if (
        pathWithinRoot === '..' ||
        pathWithinRoot.startsWith(`..${sep}`) ||
        isAbsolute(pathWithinRoot)
      )
        continue
      const stat = await lstat(image.filePath).catch(() => null)
      if (stat?.isFile())
        images.push({ path: image.filePath, operation: 'create', mediaType: 'image/png' })
    }
    return images
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) return []
  const result = output as Record<string, unknown>
  if (['Write', 'Edit', 'NotebookEdit', 'create_text_file', 'write_text_file'].includes(name)) {
    if (
      typeof result.path !== 'string' ||
      !result.path.trim() ||
      !resources[0] ||
      !isAbsolute(resources[0])
    )
      return []
    return [
      {
        path: resources[0],
        operation:
          name === 'Edit' || name === 'write_text_file' || result.replaced === true
            ? 'modify'
            : 'create'
      }
    ]
  }
  if (
    name !== 'run_shell_command' ||
    result.exitCode !== 0 ||
    result.timedOut !== false ||
    !Array.isArray(result.artifacts) ||
    result.artifacts.length > 16 ||
    !resources[0]
  )
    return []
  const files: Array<{ path: string; operation: 'create' | 'modify' }> = []
  for (const entry of result.artifacts) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const artifact = entry as Record<string, unknown>
    if (
      typeof artifact.path !== 'string' ||
      !isAbsolute(artifact.path) ||
      (artifact.operation !== 'create' && artifact.operation !== 'modify')
    )
      continue
    const pathWithinRoot = relative(resources[0], artifact.path)
    if (
      pathWithinRoot === '..' ||
      pathWithinRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathWithinRoot)
    )
      continue
    const stat = await lstat(artifact.path).catch(() => null)
    if (stat?.isFile())
      files.push({ path: artifact.path, operation: artifact.operation as 'create' | 'modify' })
  }
  return files
}

function isFailedExtensionHttpResult(output: unknown): boolean {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false
  const result = output as Record<string, unknown>
  const data = result.data
  return (
    result.__olaExtensionResult === true &&
    !!data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).ok === false
  )
}

function confirmedLinkArtifacts(output: unknown): Array<{ url: string; title: string }> {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return []
  const result = output as Record<string, unknown>
  if (result.__olaExtensionResult !== true || !Array.isArray(result.artifacts)) return []
  if (isFailedExtensionHttpResult(output)) return []
  const artifacts: Array<{ url: string; title: string }> = []
  for (const entry of result.artifacts.slice(0, 4)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const artifact = entry as Record<string, unknown>
    if (
      artifact.kind !== 'link' ||
      typeof artifact.url !== 'string' ||
      artifact.url.length > 4096 ||
      typeof artifact.title !== 'string' ||
      !artifact.title.trim() ||
      artifact.title.length > 256
    )
      continue
    try {
      const url = new URL(artifact.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
      artifacts.push({ url: url.toString(), title: artifact.title.trim() })
    } catch {
      continue
    }
  }
  return artifacts
}

export class ResourceLocks {
  private tails = new Map<string, Promise<void>>()
  async with<T>(keys: string[], signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = []
    try {
      for (const key of [...new Set(keys)].sort()) {
        signal.throwIfAborted()
        const previous = this.tails.get(key) ?? Promise.resolve()
        let release!: () => void
        const current = new Promise<void>((resolve) => {
          release = resolve
        })
        const tail = previous.then(() => current)
        this.tails.set(key, tail)
        const relinquish = (): void => {
          release()
          void tail.then(() => {
            if (this.tails.get(key) === tail) this.tails.delete(key)
          })
        }
        releases.push(relinquish)
        // A cancelled waiter returns promptly, but its tail still waits for the
        // predecessor. Later operations cannot overtake the current owner.
        await new Promise<void>((resolve, reject) => {
          const aborted = (): void => reject(signal.reason ?? new RuntimeError('RUN_CANCELLED'))
          signal.addEventListener('abort', aborted, { once: true })
          void previous.then(() => {
            signal.removeEventListener('abort', aborted)
            resolve()
          })
          if (signal.aborted) aborted()
        })
        signal.throwIfAborted()
      }
      return await operation()
    } finally {
      for (const release of releases.reverse()) release()
    }
  }
}

export class ToolExecutor {
  private definitions: Map<string, ToolDefinition>
  constructor(
    definitions: ToolDefinition[],
    private readonly authorize: (
      tool: ToolDefinition,
      input: unknown,
      context: ToolContext,
      call: ToolCall
    ) => Promise<boolean>,
    private readonly locks = new ResourceLocks()
  ) {
    this.definitions = new Map(definitions.map((tool) => [tool.name, tool]))
    if (this.definitions.size !== definitions.length) throw new RuntimeError('DUPLICATE_TOOL')
  }
  catalog(): Array<Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>> {
    return [...this.definitions.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema
    }))
  }
  async executeAll(
    calls: ToolCall[],
    context: ToolContext,
    record: (type: string, data: unknown) => Promise<void>
  ): Promise<ToolResult[]> {
    const ids = new Set(calls.map((call) => call.id))
    if (ids.size !== calls.length || calls.length > 128)
      throw new RuntimeError('INVALID_TOOL_BATCH')
    const results: ToolResult[] = []
    for (let index = 0; index < calls.length; ) {
      const group = [calls[index++]]
      if (this.definitions.get(group[0].name)?.effect === 'read') {
        while (
          group.length < 4 &&
          index < calls.length &&
          this.definitions.get(calls[index].name)?.effect === 'read'
        )
          group.push(calls[index++])
      }
      const batch = await Promise.allSettled(
        group.map((call) => this.executeOne(call, context, record))
      )
      for (const item of batch) {
        if (item.status === 'rejected') throw item.reason
        results.push(item.value)
      }
    }
    return results
  }
  private async executeOne(
    call: ToolCall,
    context: ToolContext,
    record: (type: string, data: unknown) => Promise<void>
  ): Promise<ToolResult> {
    context.signal.throwIfAborted()
    const tool = this.definitions.get(call.name)
    if (!tool) return { id: call.id, name: call.name, output: 'UNKNOWN_TOOL', isError: true }
    let input: unknown
    try {
      input = tool.validate(call.input)
    } catch {
      return { id: call.id, name: call.name, output: 'INVALID_TOOL_INPUT', isError: true }
    }
    const authorized = await this.authorize(tool, input, context, call)
    context.signal.throwIfAborted()
    if (!authorized)
      return { id: call.id, name: call.name, output: 'PERMISSION_DENIED', isError: true }
    const resources = await tool.resources(input, context)
    context.signal.throwIfAborted()
    if (tool.effect === 'write' && !resources.length)
      throw new RuntimeError('MISSING_RESOURCE_LOCK')
    const execute = async (): Promise<ToolResult> => {
      context.signal.throwIfAborted()
      await record('tool.started', { id: call.id, name: call.name, effect: tool.effect })
      context.signal.throwIfAborted()
      let result: ToolResult
      try {
        const output = await tool.execute(input, { ...context, toolCallId: call.id })
        const imageOutput = parseRuntimeToolImageOutput(output)
        result = {
          id: call.id,
          name: call.name,
          output: imageOutput?.text ?? output,
          ...(imageOutput ? { images: imageOutput.images } : {}),
          ...(isFailedExtensionHttpResult(output) ? { isError: true } : {})
        }
      } catch {
        // A cancelled effect is intentionally left without a result: recovery must not retry it.
        context.signal.throwIfAborted()
        result = { id: call.id, name: call.name, output: 'TOOL_FAILED', isError: true }
      }
      context.signal.throwIfAborted()
      await record('tool.result', result)
      if (!result.isError) {
        const artifacts = await confirmedFileArtifacts(call.name, result.output, resources)
        for (const artifact of artifacts)
          await record('artifact.registered', {
            toolCallId: call.id,
            kind: 'file',
            transport: 'local',
            path: artifact.path,
            operation: artifact.operation,
            ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {})
          })
        const links = confirmedLinkArtifacts(result.output)
        for (const artifact of links)
          await record('artifact.registered', {
            toolCallId: call.id,
            kind: 'link',
            transport: 'remote',
            url: artifact.url,
            title: artifact.title
          })
        const hostArtifacts = await tool
          .artifacts?.(result.output, { ...context, toolCallId: call.id })
          .catch(() => [])
        for (const artifact of hostArtifacts ?? [])
          await record('artifact.registered', {
            toolCallId: call.id,
            ...artifact
          })
      }
      return result
    }
    // Reads have no side effect and are deliberately not resource-locked: a
    // batch may perform up to four independent or same-file inspections in
    // parallel. Writes retain a canonical lock across all runs.
    return tool.effect === 'write' || tool.serializeReads
      ? await this.locks.with(resources, context.signal, execute)
      : await execute()
  }
}
