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
export type {
  ModelToolCall as ToolCall,
  ModelToolResult as ToolResult
} from '../../shared/runtime/model'

export interface ToolContext {
  run: RunSpec
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
  validate: (input: unknown) => unknown
  /** Canonical resource ids come from the host, never directly from model arguments. */
  resources: (input: unknown, context: ToolContext) => Promise<string[]>
  execute: (input: unknown, context: ToolContext) => Promise<unknown>
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
        result = { id: call.id, name: call.name, output: await tool.execute(input, context) }
      } catch {
        // A cancelled effect is intentionally left without a result: recovery must not retry it.
        context.signal.throwIfAborted()
        result = { id: call.id, name: call.name, output: 'TOOL_FAILED', isError: true }
      }
      context.signal.throwIfAborted()
      await record('tool.result', result)
      return result
    }
    // Reads have no side effect and are deliberately not resource-locked: a
    // batch may perform up to four independent or same-file inspections in
    // parallel. Writes retain a canonical lock across all runs.
    return tool.effect === 'read'
      ? await execute()
      : await this.locks.with(resources, context.signal, execute)
  }
}
