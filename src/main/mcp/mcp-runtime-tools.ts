import { RuntimeError } from '../../shared/runtime/contracts'
import type { McpTool } from './mcp-types'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'

const MAX_INPUT_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 128 * 1024
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,96}$/

export interface McpRuntimeManager {
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
  serverIds: readonly string[]
): ToolDefinition[] {
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
        execute: async (value, context) => {
          const result = await manager.callTool(
            serverId,
            mcpTool.name,
            value as Record<string, unknown>
          )
          context.signal.throwIfAborted()
          try {
            if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES)
              throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
          } catch (error) {
            if (error instanceof RuntimeError) throw error
            throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
          }
          return result
        }
      })
    }
  }
  return tools
}
