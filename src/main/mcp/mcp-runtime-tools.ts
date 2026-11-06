import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { materializeMcpArtifacts } from './mcp-result-files'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ExposedMcpTool, McpOutputLimits } from './mcp-types'
import type { ToolContext, ToolDefinition } from '../../runtime/tools/tool-executor'
import { sanitizeDescription } from '../../shared/tool-naming'
import { mcpExternalToolNameString } from '../../shared/mcp-tool-policy'

const MAX_INPUT_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 128 * 1024
/** Spill ceiling for one oversized text block; beyond it the reduction has nothing left to do. */
const MAX_SPILLED_TEXT_BYTES = 8 * 1024 * 1024
/**
 * Text is measured as raw UTF-8 but travels inside a JSON envelope, so keeping the full inline
 * budget worth of characters would still produce a result over the ceiling. This covers escaping,
 * the truncation notice and object overhead.
 */
const REDUCTION_RESERVE = 8192

export interface McpRuntimeManager {
  readResource?(serverId: string, uri: string): Promise<unknown>
  /** Only the tools this server exposes to the model, each already carrying its external name. */
  getTools(serverId: string): ExposedMcpTool[]
  /**
   * Resources the server serves. Each becomes a read-only tool in the same alias namespace, named
   * `resource__<name>` exactly as the renderer registers it, so one `run.toolNames` entry means the
   * same capability whichever side executes the run.
   */
  getResources?(serverId: string): McpAdvertisedResource[]
  callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>
  /** The per-server namespace external names were built from, needed to spill files per server. */
  getToolAlias?(serverId: string): string
  /** Size policy and deadline the server was configured with. */
  getOutputLimits?(serverId: string): McpOutputLimits | undefined
}

export interface McpAdvertisedResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

function input(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_INPUT_BYTES)
      throw new RuntimeError('INVALID_TOOL_INPUT')
  } catch (error) {
    if (error instanceof RuntimeError) throw error
    throw new RuntimeError('INVALID_TOOL_INPUT')
  }
  return value as Record<string, unknown>
}

/**
 * Shrink an oversized `content` array so the result still fits the inline budget.
 *
 * Media blocks already have their file counterparts from `materializeMcpArtifacts`, so they
 * collapse to a pointer. Plain text is the interesting case: a decompiler emitting a 400 KB
 * pseudocode body used to fail the call outright, losing the answer even though the agent could
 * read it from disk. Writing it to the managed results directory and returning the path keeps the
 * information reachable while the model context stays bounded. A spill directory that is absent
 * (no managed root configured) leaves the text inline, and the hard ceiling still fails the call —
 * the failure is then real rather than an artifact of where we chose to write.
 */
async function reduceOversizedBlocks(
  content: unknown[],
  materializedPaths: readonly string[],
  inlineTextBytes: number,
  managedDirectory: string | undefined,
  serverId: string,
  toolName: string
): Promise<unknown[]> {
  const pointer =
    materializedPaths.length > 0
      ? `MCP file results: ${materializedPaths.join(', ')}`
      : 'MCP result contained binary blocks that exceeded the inline budget and were not stored.'
  let budgetLeft = Math.max(inlineTextBytes - REDUCTION_RESERVE, 512)
  const reduced: unknown[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      reduced.push(block)
      continue
    }
    const entry = block as Record<string, unknown>
    if (['image', 'audio', 'resource'].includes(String(entry.type))) {
      reduced.push({ type: 'text', text: pointer })
      continue
    }
    if (entry.type !== 'text' || typeof entry.text !== 'string') {
      reduced.push(entry)
      continue
    }
    const size = Buffer.byteLength(entry.text)
    if (size <= budgetLeft) {
      budgetLeft -= size
      reduced.push(entry)
      continue
    }
    const spillPath = await spillText(entry.text, managedDirectory, serverId, toolName)
    if (!spillPath) {
      // No place to put it: truncate rather than lose the block entirely. The notice is part of
      // the payload, so the head has to leave room for it or the truncation re-breaks the budget.
      const notice = `\n[mcp output truncated at ${size} bytes; no managed result directory]`
      const keep = Math.max(budgetLeft - Buffer.byteLength(notice), 0)
      const head = entry.text.slice(0, truncateToBytes(entry.text, keep))
      budgetLeft = 0
      reduced.push({ type: 'text', text: `${head}${notice}` })
      continue
    }
    budgetLeft = 0
    reduced.push({
      type: 'text',
      text: `[${size} bytes written to ${spillPath} — read it with the file tools instead of re-requesting this tool]`
    })
  }
  return reduced
}

/** Write one oversized text block into the managed results directory. `undefined` when there is none. */
async function spillText(
  text: string,
  managedDirectory: string | undefined,
  serverId: string,
  toolName: string
): Promise<string | undefined> {
  if (!managedDirectory || Buffer.byteLength(text) > MAX_SPILLED_TEXT_BYTES) return undefined
  try {
    await mkdir(managedDirectory, { recursive: true })
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 12)
    const safeTool = toolName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)
    const path = join(
      managedDirectory,
      `${sanitizeSegment(serverId)}--${safeTool}-${digest}-${randomUUID().slice(0, 8)}.txt`
    )
    await writeFile(path, text, 'utf8')
    return path
  } catch {
    return undefined
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
}

/** Character count whose UTF-8 encoding still fits `maxBytes`, so a cut never splits a code point. */
function truncateToBytes(text: string, maxBytes: number): number {
  if (maxBytes <= 0) return 0
  let bytes = 0
  let characters = 0
  for (const character of text) {
    const width = Buffer.byteLength(character)
    if (bytes + width > maxBytes) break
    bytes += width
    characters += character.length
  }
  return characters
}

/**
 * Converts already-connected Main-owned MCP capabilities into Runtime tools.
 * MCP servers declare their own side effects, so calls are conservatively
 * treated as write effects until per-tool capability metadata is available.
 */
export function createMcpRuntimeTools(
  manager: McpRuntimeManager,
  serverIds: readonly string[],
  managedResultDirectory?: (context: ToolContext) => string
): ToolDefinition[] {
  const prepared = new WeakMap<object, Awaited<ReturnType<typeof materializeMcpArtifacts>>>()
  const tools: ToolDefinition[] = []
  const names = new Set<string>()
  for (const serverId of [...new Set(serverIds)].sort()) {
    const alias = manager.getToolAlias?.(serverId) ?? ''
    const limits = manager.getOutputLimits?.(serverId)
    const inlineTextBytes = Math.max(limits?.inlineTextBytes ?? MAX_OUTPUT_BYTES, 1024)
    const maxResultBytes = Math.max(limits?.maxResultBytes ?? MAX_OUTPUT_BYTES, inlineTextBytes)
    for (const mcpTool of manager.getTools(serverId)) {
      // `getTools` already filtered to exposable tools, but the name is recomputed rather than
      // trusted from the payload: this is the value the registry keys on, and the renderer must be
      // able to derive the identical string from the same two inputs.
      const name = mcpExternalToolNameString(alias, mcpTool.name)
      if (!name) continue
      if (names.has(name)) {
        // Two servers can only collide if their aliases were assigned outside the store, and a
        // dropped tool would otherwise look like a server that stopped advertising it.
        console.warn(`[MCP] external name ${name} already registered; skipping ${mcpTool.name}`)
        continue
      }
      names.add(name)
      const description = sanitizeDescription(
        mcpTool.description || `Call MCP tool ${mcpTool.name} on ${serverId}.`
      )
      tools.push({
        name,
        description,
        inputSchema: mcpTool.inputSchema ?? {},
        effect: 'write',
        validate: input,
        resources: async () => [`mcp:${serverId}:${mcpTool.name}`],
        artifacts: async (output) => {
          if (!output || typeof output !== 'object' || Array.isArray(output)) return []
          const result = output as Record<string, unknown>
          if (result.isError === true || !Array.isArray(result.content)) return []
          const links: Array<{ kind: 'link'; transport: 'remote'; url: string; title: string }> = []
          const seen = new Set<string>()
          // Only the MCP resource_link contract is trusted; text and local URIs are not paths.
          for (const block of result.content.slice(0, 64)) {
            if (!block || typeof block !== 'object' || Array.isArray(block)) continue
            const entry = block as Record<string, unknown>
            if (
              entry.type !== 'resource_link' ||
              typeof entry.uri !== 'string' ||
              entry.uri.length > 4096 ||
              typeof entry.name !== 'string' ||
              !entry.name.trim()
            )
              continue
            try {
              const url = new URL(entry.uri)
              if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
                continue
              if (seen.has(url.href)) continue
              seen.add(url.href)
              links.push({
                kind: 'link',
                transport: 'remote',
                url: url.href,
                title: (typeof entry.title === 'string' && entry.title.trim()
                  ? entry.title
                  : entry.name
                )
                  .trim()
                  .slice(0, 256)
              })
              if (links.length === 16) break
            } catch {
              continue
            }
          }
          return [...links, ...(prepared.get(result) ?? [])]
        },
        execute: async (value, context) => {
          let result = await manager.callTool(
            serverId,
            mcpTool.name,
            value as Record<string, unknown>
          )
          context.signal.throwIfAborted()
          if (
            result &&
            typeof result === 'object' &&
            'isError' in result &&
            result.isError === true
          )
            throw new RuntimeError('MCP_TOOL_FAILED')
          try {
            if (Buffer.byteLength(JSON.stringify(result)) > 24 * 1024 * 1024)
              throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
          } catch (error) {
            if (error instanceof RuntimeError) throw error
            throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
          }
          if (result && typeof result === 'object') {
            const files = await materializeMcpArtifacts(
              result,
              context,
              manager,
              serverId,
              managedResultDirectory?.(context)
            )
            if (Buffer.byteLength(JSON.stringify(result)) > inlineTextBytes) {
              const record = result as Record<string, unknown>
              if (Array.isArray(record.content)) {
                result = {
                  ...record,
                  content: await reduceOversizedBlocks(
                    record.content,
                    files.map((file) => file.path),
                    inlineTextBytes,
                    managedResultDirectory?.(context),
                    serverId,
                    mcpTool.name
                  )
                }
              }
            }
            if (Buffer.byteLength(JSON.stringify(result)) > maxResultBytes)
              throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
            prepared.set(result as object, files)
          }
          return result
        }
      })
    }
    const readResource = manager.readResource?.bind(manager)
    if (!readResource) continue
    for (const resource of manager.getResources?.(serverId) ?? []) {
      const resourceName = typeof resource.name === 'string' ? resource.name.trim() : ''
      const resourceUri = typeof resource.uri === 'string' ? resource.uri.trim() : ''
      if (!resourceName || !resourceUri) continue
      // `resource__<name>` is the segment the renderer registers for the same resource, so a run
      // that names the tool executes the same capability whichever side owns the run.
      const name = mcpExternalToolNameString(alias, `resource__${resourceName}`)
      if (!name) continue
      if (names.has(name)) {
        console.warn(
          `[MCP] external name ${name} already registered; skipping resource ${resourceName}`
        )
        continue
      }
      names.add(name)
      tools.push({
        name,
        description: sanitizeDescription(
          resource.description
            ? `Read MCP resource ${resourceName} on ${serverId}: ${resource.description}`
            : `Read MCP resource ${resourceName} (${resource.mimeType ?? 'unknown'}) on ${serverId}.`
        ),
        inputSchema: { type: 'object', properties: {} },
        effect: 'read',
        // A resource takes no arguments; anything the model sends is discarded rather than forwarded.
        validate: () => ({}),
        resources: async () => [`mcp:${serverId}:${resourceUri}`],
        execute: async (_value, context) => {
          const result = await readResource(serverId, resourceUri)
          context.signal.throwIfAborted()
          if (!result || typeof result !== 'object' || Array.isArray(result)) return result
          const files = await materializeMcpArtifacts(
            result,
            context,
            manager,
            serverId,
            managedResultDirectory?.(context)
          )
          // Inline text keeps the tool's hard ceiling: past it the call fails rather than shipping
          // an unbounded resource body into the model context.
          if (Buffer.byteLength(JSON.stringify(result)) > maxResultBytes)
            throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
          prepared.set(result as object, files)
          return result
        },
        artifacts: async (output) => {
          if (!output || typeof output !== 'object' || Array.isArray(output)) return []
          return prepared.get(output as object) ?? []
        }
      })
    }
  }
  return tools
}
