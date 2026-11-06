import { toolRegistry } from '../agent/tool-registry'
import type { ToolHandler } from '../tools/tool-types'
import type { ExposedMcpTool, McpResource, McpServerConfig } from './types'
import { encodeStructuredToolResult } from '../tools/tool-result-format'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'
import {
  MCP_TOOL_NAME_PREFIX,
  mcpExternalToolName,
  parseMcpExternalToolName
} from '../../../../shared/mcp-tool-policy'

/**
 * MCP Tool & Resource Bridge — maps the exposed tool set Main ships over IPC to ToolHandlers in
 * the global tool registry. Names are consumed verbatim from `externalName` (tools) or composed
 * with the pure `mcpExternalToolName(alias, ...)` (resources). The renderer never re-derives a
 * name from a server id; that divergence made connected tools vanish from runs silently.
 */

/** Registered names plus their owning server id, so cleanup never decodes ids from names. */
let _registeredMcp: Array<{ name: string; serverId: string }> = []

/**
 * Decode an external MCP tool name. For canonical names the first segment is the server's alias
 * (map it back to an id via `McpServerConfig.toolAlias`); for legacy names it is the stored server
 * id, which is how pre-alias tools are recorded in old transcripts.
 */
export function parseMcpToolName(
  prefixedName: string
): { serverId: string; toolName: string } | null {
  const parsed = parseMcpExternalToolName(prefixedName)
  if (!parsed) return null
  return { serverId: parsed.alias, toolName: parsed.toolSegment }
}

/** Check if a tool name is an MCP tool */
export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_NAME_PREFIX)
}

/**
 * Register exactly the exposed tools Main named, using its external names verbatim. Entries
 * without `externalName` carry a `reason` or `filtered` and are not registerable; skipping them
 * is the fail-closed default.
 */
export function registerMcpTools(
  activeServers: McpServerConfig[],
  toolsMap: Record<string, ExposedMcpTool[]>
): void {
  // Unregister any previously registered MCP tools/resources first
  unregisterMcpTools()

  const newEntries: Array<{ name: string; serverId: string }> = []

  for (const server of activeServers) {
    const tools = toolsMap[server.id]
    if (!tools?.length) continue

    for (const mcpTool of tools) {
      if (!mcpTool.externalName) continue

      const name = mcpTool.externalName

      const handler: ToolHandler = {
        definition: {
          name,
          description: `[MCP: ${server.name}] ${mcpTool.description ?? mcpTool.name}`,
          inputSchema: {
            type: 'object',
            properties: (mcpTool.inputSchema?.properties as Record<string, unknown>) ?? {},
            required: (mcpTool.inputSchema?.required as string[]) ?? []
          }
        },
        execute: async (input, ctx) => {
          // Main routes the call by the server-advertised name, not the external name.
          const result = await ipcClient.invoke(IPC.MCP_CALL_TOOL, {
            serverId: server.id,
            toolName: mcpTool.name,
            args: input
          })
          ctx.signal.throwIfAborted()
          return encodeStructuredToolResult(result as Record<string, unknown> | unknown[])
        },
        requiresApproval: () => true
      }

      toolRegistry.register(handler, {
        namespace: 'mcp',
        owner: `mcp:${server.id}`,
        capability: {
          readOnly: false,
          riskLevel: 'medium',
          requiresApproval: true,
          projectScoped: Boolean(server.projectId)
        }
      })
      newEntries.push({ name, serverId: server.id })
    }
  }

  _registeredMcp = newEntries
}

/**
 * Register MCP resources as tools. Resource names live in the same alias namespace as tools with
 * a `resource__` segment; a server without `toolAlias` cannot name them and is skipped.
 */
export function registerMcpResources(
  activeServers: McpServerConfig[],
  resourcesMap: Record<string, McpResource[]>
): void {
  for (const server of activeServers) {
    const resources = resourcesMap[server.id]
    if (!resources?.length) continue
    if (!server.toolAlias) continue

    for (const resource of resources) {
      const built = mcpExternalToolName(server.toolAlias, `resource__${resource.name}`)
      if (!built.ok) continue

      const name = built.name

      const handler: ToolHandler = {
        definition: {
          name,
          description: `[MCP: ${server.name}] Resource: ${resource.name}${resource.description ? ` — ${resource.description}` : ''} (${resource.mimeType ?? 'unknown'})`,
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        execute: async (_input, ctx) => {
          const result = await ipcClient.invoke(IPC.MCP_READ_RESOURCE, {
            serverId: server.id,
            uri: resource.uri,
            resourceName: resource.name
          })
          ctx.signal.throwIfAborted()
          return encodeStructuredToolResult(result as Record<string, unknown> | unknown[])
        },
        requiresApproval: () => true
      }

      toolRegistry.register(handler, {
        namespace: 'mcp',
        owner: `mcp:${server.id}`,
        capability: {
          readOnly: true,
          riskLevel: 'low',
          requiresApproval: false,
          projectScoped: Boolean(server.projectId)
        }
      })
      _registeredMcp.push({ name, serverId: server.id })
    }
  }
}

/** Unregister all previously registered MCP tools and resources */
export function unregisterMcpTools(): void {
  for (const entry of _registeredMcp) {
    toolRegistry.unregister(entry.name, `mcp:${entry.serverId}`)
  }
  _registeredMcp = []
}

/** Check if any MCP tools or resources are currently registered */
export function isMcpToolsRegistered(): boolean {
  return _registeredMcp.length > 0
}

/** Get count of currently registered MCP tools and resources */
export function getMcpToolCount(): number {
  return _registeredMcp.length
}
