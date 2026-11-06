import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { olaDataRoot } from '../lib/ola-data-root'
import {
  deriveMcpToolAlias,
  normalizeMcpToolNames,
  normalizeMcpToolPresets,
  validateMcpExposure
} from '../../shared/mcp-tool-policy'
import type { McpServerConfig } from './mcp-types'

export type McpMutationResult = { success: true } | { success: false; error: string }

export class McpConfigStore {
  private pendingWrite: Promise<void> = Promise.resolve()

  constructor(private readonly filePath = join(olaDataRoot(), 'mcp-servers.json')) {}

  async list(): Promise<McpServerConfig[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!Array.isArray(parsed)) return []
      const taken = new Set<string>()
      const servers: McpServerConfig[] = []
      for (const entry of parsed) {
        const server = normalizeStoredServer(entry)
        if (!server) continue
        if (server.toolAlias) taken.add(server.toolAlias)
        servers.push(server)
      }
      return servers
    } catch {
      return []
    }
  }

  async get(id: string | undefined): Promise<{ server: McpServerConfig | null }> {
    if (!id?.trim()) return { server: null }
    return { server: (await this.list()).find((server) => server?.id === id) ?? null }
  }

  async add(config: McpServerConfig): Promise<McpMutationResult> {
    if (!isRecord(config)) return { success: false, error: 'Invalid MCP server config' }
    return await this.mutate((servers) => {
      const taken = new Set(
        servers.map((server) => server.toolAlias).filter((alias): alias is string => Boolean(alias))
      )
      // The alias is chosen from the name once, at creation, and frozen afterwards. `name` is
      // user-editable and the panel debounces those edits, so a recomputed alias would rename
      // tool identities that transcripts already recorded.
      const named = String(config.name ?? '').trim()
      const alias =
        deriveMcpToolAlias(String(config.id), named, taken) ||
        deriveMcpToolAlias(String(config.id), undefined, taken)
      const next: McpServerConfig = {
        ...config,
        toolAlias: alias,
        createdAt:
          typeof config.createdAt === 'number' && config.createdAt > 0
            ? config.createdAt
            : Date.now()
      }
      const prepared = applyExposurePolicy(next)
      if (!prepared.ok) return { success: false, error: prepared.error }
      servers.push(prepared.server)
      return { success: true }
    })
  }

  async update(id: string, patch: Partial<McpServerConfig>): Promise<McpMutationResult> {
    if (!id?.trim() || !isRecord(patch))
      return { success: false, error: 'Invalid MCP server update' }
    return await this.mutate((servers) => {
      const index = servers.findIndex((server) => server?.id === id)
      if (index < 0) return { success: false, error: 'Server not found' }
      // `toolAlias` is deliberately dropped from the patch: a client must not be able to move a
      // whole server's tool namespace by renaming its display label.
      const { toolAlias: _frozen, ...safePatch } = patch
      const merged: McpServerConfig = { ...servers[index], ...safePatch }
      const prepared = applyExposurePolicy(merged)
      if (!prepared.ok) return { success: false, error: prepared.error }
      servers[index] = prepared.server
      return { success: true }
    })
  }

  async remove(id: string): Promise<McpMutationResult> {
    if (!id?.trim()) return { success: false, error: 'Invalid MCP server id' }
    return await this.mutate((servers) => {
      const next = servers.filter((server) => server?.id !== id)
      if (next.length !== servers.length) servers.splice(0, servers.length, ...next)
      return { success: true }
    })
  }

  private async mutate(
    change: (servers: McpServerConfig[]) => McpMutationResult
  ): Promise<McpMutationResult> {
    let result: McpMutationResult = { success: false, error: 'MCP config write failed' }
    this.pendingWrite = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        const servers = await this.list()
        result = change(servers)
        if (!result.success) return
        await atomicWriteJson(this.filePath, servers)
      })
      .catch((error) => {
        result = { success: false, error: error instanceof Error ? error.message : String(error) }
      })
    await this.pendingWrite
    return result
  }
}

/**
 * Canonicalize one stored entry. Returns `undefined` for anything that is not a usable server
 * record so a hand-edited or partially written config file cannot poison the whole list —
 * previously the array was blind-cast, so a single malformed entry reached the client layer.
 *
 * `toolAlias` is filled in here rather than persisted lazily: deriving it from the immutable `id`
 * is pure, so Main and the renderer compute the same namespace from the same file without a
 * migration and without a write on the read path.
 */
export function normalizeStoredServer(value: unknown): McpServerConfig | undefined {
  if (!isRecord(value)) return undefined
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!id || !name) return undefined
  const transport = value.transport
  if (transport !== 'stdio' && transport !== 'sse' && transport !== 'streamable-http')
    return undefined

  const server: McpServerConfig = {
    id,
    name,
    enabled: value.enabled !== false,
    transport,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0
  }

  if (typeof value.projectId === 'string' || value.projectId === null)
    server.projectId = value.projectId as string | null
  if (typeof value.command === 'string') server.command = value.command
  if (Array.isArray(value.args))
    server.args = value.args.filter((arg): arg is string => typeof arg === 'string')
  if (isRecord(value.env)) {
    const env: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value.env))
      if (typeof entry === 'string') env[key] = entry
    server.env = env
  }
  if (typeof value.cwd === 'string') server.cwd = value.cwd
  if (typeof value.url === 'string') server.url = value.url
  if (isRecord(value.headers)) {
    const headers: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value.headers))
      if (typeof entry === 'string') headers[key] = entry
    server.headers = headers
  }
  if (isRecord(value.auth)) {
    const auth: NonNullable<McpServerConfig['auth']> = {}
    if (typeof value.auth.clientId === 'string') auth.clientId = value.auth.clientId
    if (typeof value.auth.scope === 'string') auth.scope = value.auth.scope
    server.auth = auth
  }
  if (typeof value.autoFallback === 'boolean') server.autoFallback = value.autoFallback
  if (typeof value.description === 'string') server.description = value.description
  if (typeof value.timeoutMs === 'number' && value.timeoutMs > 0)
    server.timeoutMs = Math.min(Math.round(value.timeoutMs), 3_600_000)
  if (isRecord(value.preflight)) server.preflight = normalizePreflight(value.preflight)
  if (isRecord(value.outputLimits)) server.outputLimits = normalizeOutputLimits(value.outputLimits)
  if (typeof value.ignorePreflight === 'boolean') server.ignorePreflight = value.ignorePreflight

  const enabledTools = normalizeMcpToolNames(value.enabledTools)
  if (enabledTools) server.enabledTools = enabledTools
  const toolPresets = normalizeMcpToolPresets(value.toolPresets)
  if (toolPresets) server.toolPresets = toolPresets
  if (typeof value.activePreset === 'string' && value.activePreset.trim())
    server.activePreset = value.activePreset.trim()

  // Legacy backfill: hashed from `id` only. A name-derived alias would change the moment the user
  // edited the label, silently re-naming every tool the model was already calling.
  const storedAlias = typeof value.toolAlias === 'string' ? value.toolAlias.trim() : ''
  server.toolAlias = storedAlias || deriveMcpToolAlias(id)

  return server
}

function normalizePreflight(
  value: Record<string, unknown>
): NonNullable<McpServerConfig['preflight']> {
  const preflight: NonNullable<McpServerConfig['preflight']> = {}
  if (typeof value.nodeCommand === 'string' && value.nodeCommand.trim())
    preflight.nodeCommand = value.nodeCommand.trim()
  if (typeof value.nodeRange === 'string' && value.nodeRange.trim())
    preflight.nodeRange = value.nodeRange.trim()
  const commands = normalizeMcpToolNames(value.requiredCommands)
  if (commands) preflight.requiredCommands = commands
  return preflight
}

function normalizeOutputLimits(
  value: Record<string, unknown>
): NonNullable<McpServerConfig['outputLimits']> {
  const limits: NonNullable<McpServerConfig['outputLimits']> = {}
  if (typeof value.inlineTextBytes === 'number' && value.inlineTextBytes > 0)
    limits.inlineTextBytes = Math.round(value.inlineTextBytes)
  if (typeof value.maxResultBytes === 'number' && value.maxResultBytes > 0)
    limits.maxResultBytes = Math.round(value.maxResultBytes)
  return limits
}

/**
 * Normalize the exposure fields and enforce the per-server ceiling. Mutating `servers` in place
 * through the caller's reference is intentional: `mutate` re-reads, validates, then writes the
 * array it was handed, so a rejected write never reaches disk.
 */
function applyExposurePolicy(
  server: McpServerConfig
): { ok: true; server: McpServerConfig } | { ok: false; error: string } {
  const next: McpServerConfig = { ...server }
  const enabledTools = normalizeMcpToolNames(next.enabledTools)
  if (enabledTools) next.enabledTools = enabledTools
  else delete next.enabledTools
  const toolPresets = normalizeMcpToolPresets(next.toolPresets)
  if (toolPresets && Object.keys(toolPresets).length) next.toolPresets = toolPresets
  else delete next.toolPresets
  if (typeof next.activePreset === 'string' && next.activePreset.trim())
    next.activePreset = next.activePreset.trim()
  else delete next.activePreset

  const check = validateMcpExposure(next)
  if (!check.ok) return { ok: false, error: check.error }
  return { ok: true, server: next }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = join(dirname(filePath), `mcp-servers.${randomUUID()}.tmp`)
  await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8')
  await rename(tempPath, filePath)
}
