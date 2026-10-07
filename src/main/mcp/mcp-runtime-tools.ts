import { materializeMcpArtifacts } from './mcp-result-files'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { McpTool } from './mcp-types'
import type { ToolContext, ToolDefinition } from '../../runtime/tools/tool-executor'

const MAX_INPUT_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 128 * 1024
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,96}$/

export interface McpRuntimeManager {
  readResource?(serverId: string, uri: string): Promise<unknown>
  getTools(serverId: string): McpTool[]
  callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>
}

function runtimeToolName(serverId: string, toolName: string): string | null {
  if (!SAFE_SEGMENT.test(serverId) || !SAFE_SEGMENT.test(toolName)) return null
  return `mcp__${serverId}__${toolName}`
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
    for (const mcpTool of manager.getTools(serverId)) {
      const name = runtimeToolName(serverId, mcpTool.name)
      if (!name || names.has(name)) continue
      names.add(name)
      tools.push({
        name,
        description: mcpTool.description || `Call MCP tool ${mcpTool.name} on ${serverId}.`,
        inputSchema: mcpTool.inputSchema,
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
            if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) {
              const record = result as Record<string, unknown>
              if (Array.isArray(record.content)) {
                result = {
                  ...record,
                  content: record.content.map((block) => {
                    if (!block || typeof block !== 'object') return block
                    if (['image', 'audio', 'resource'].includes(block.type))
                      return {
                        type: 'text',
                        text: `MCP file results: ${files.map((file) => file.path).join(', ')}`
                      }
                    return block
                  })
                }
              }
            }
            if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES)
              throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
            prepared.set(result as object, files)
          }
          return result
        }
      })
    }
  }
  return tools
}
