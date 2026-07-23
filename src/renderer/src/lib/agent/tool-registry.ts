import type { ToolDefinition, ToolResultContent } from '../api/types'
import type { ToolHandler, ToolContext } from '../tools/tool-types'
import { encodeToolError } from '../tools/tool-result-format'

function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function compareToolDefinitions(a: ToolDefinition, b: ToolDefinition): number {
  const byName = a.name.localeCompare(b.name)
  if (byName !== 0) return byName
  const byDescription = a.description.localeCompare(b.description)
  if (byDescription !== 0) return byDescription
  return stableStringify(a.inputSchema).localeCompare(stableStringify(b.inputSchema))
}

/**
 * Tool Registry - manages tool handlers with a pluggable registration pattern.
 * New tools are added by calling register() without modifying core code.
 */
export type ToolNamespace = 'core' | 'extension' | 'mcp' | 'channel'

export interface ToolRegistrationOptions {
  namespace: ToolNamespace
  owner: string
  version?: string
  capabilityHash?: string
}

export interface ToolRegistrationMetadata extends ToolRegistrationOptions {
  name: string
  capabilityHash: string
}

export interface ToolRegistrationConflict {
  name: string
  existing: ToolRegistrationMetadata
  rejected: ToolRegistrationMetadata
}

function capabilityHash(definition: ToolDefinition): string {
  const source = `${definition.name}\n${definition.description}\n${stableStringify(definition.inputSchema)}`
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function normalizeRegistration(
  handler: ToolHandler,
  options?: ToolRegistrationOptions
): ToolRegistrationMetadata {
  return {
    name: handler.definition.name,
    namespace: options?.namespace ?? 'core',
    owner: options?.owner ?? 'core',
    ...(options?.version ? { version: options.version } : {}),
    capabilityHash: options?.capabilityHash ?? capabilityHash(handler.definition)
  }
}

export class ToolRegistry {
  private tools = new Map<string, ToolHandler>()
  private registrations = new Map<string, ToolRegistrationMetadata>()
  private conflicts: ToolRegistrationConflict[] = []
  private listeners = new Set<() => void>()
  private definitionsCache: ToolDefinition[] | null = []
  private namesCache: string[] | null = []
  private stableDefinitionsCache: ToolDefinition[] | null = []
  private stableNamesCache: string[] | null = []

  private invalidate(): void {
    this.definitionsCache = null
    this.namesCache = null
    this.stableDefinitionsCache = null
    this.stableNamesCache = null
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  register(handler: ToolHandler, options?: ToolRegistrationOptions): boolean {
    const registration = normalizeRegistration(handler, options)
    const existing = this.registrations.get(registration.name)
    if (
      existing &&
      (existing.namespace !== registration.namespace || existing.owner !== registration.owner)
    ) {
      this.conflicts.push({ name: registration.name, existing, rejected: registration })
      if (this.conflicts.length > 100) this.conflicts.shift()
      return false
    }

    const prev = this.tools.get(registration.name)
    this.tools.set(registration.name, handler)
    this.registrations.set(registration.name, registration)
    if (prev !== handler) {
      this.invalidate()
      this.emit()
    }
    return true
  }

  unregister(name: string, owner = 'core'): boolean {
    const registration = this.registrations.get(name)
    if (!registration || registration.owner !== owner) return false
    this.registrations.delete(name)
    if (this.tools.delete(name)) {
      this.invalidate()
      this.emit()
      return true
    }
    return false
  }

  getRegistration(name: string): ToolRegistrationMetadata | undefined {
    return this.registrations.get(name)
  }

  getConflicts(): ToolRegistrationConflict[] {
    return [...this.conflicts]
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  getDefinitions(): ToolDefinition[] {
    if (!this.definitionsCache) {
      this.definitionsCache = Array.from(this.tools.values()).map((t) => t.definition)
    }
    return this.definitionsCache
  }

  getStableDefinitions(): ToolDefinition[] {
    if (!this.stableDefinitionsCache) {
      this.stableDefinitionsCache = [...this.getDefinitions()].sort(compareToolDefinitions)
    }
    return this.stableDefinitionsCache
  }

  getNames(): string[] {
    if (!this.namesCache) {
      this.namesCache = Array.from(this.tools.keys())
    }
    return this.namesCache
  }

  getStableNames(): string[] {
    if (!this.stableNamesCache) {
      this.stableNamesCache = this.getStableDefinitions().map((tool) => tool.name)
    }
    return this.stableNamesCache
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResultContent> {
    const handler =
      ctx.localToolHandlers?.[name] ?? ctx.inlineToolHandlers?.[name] ?? this.tools.get(name)
    if (!handler) {
      return encodeToolError(`Unknown tool: ${name}`)
    }
    try {
      return await handler.execute(input, ctx)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return encodeToolError(message)
    }
  }

  checkRequiresApproval(name: string, input: Record<string, unknown>, ctx: ToolContext): boolean {
    const handler =
      ctx.localToolHandlers?.[name] ?? ctx.inlineToolHandlers?.[name] ?? this.tools.get(name)
    if (!handler) return true // Unknown tools always require approval
    return handler.requiresApproval?.(input, ctx) ?? false
  }
}

export const toolRegistry = new ToolRegistry()
