import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'
import type { IPCChannel } from '../../../../shared/ipc/contract'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'
import {
  WORKSPACE_PROTOCOL_TOOLS,
  workspaceToolDefinition
} from '../../../../shared/tool-catalog/workspace-protocol'

async function invokeSearch(
  channel: IPCChannel,
  input: Record<string, unknown>,
  ctx: Parameters<ToolHandler['execute']>[1]
): Promise<string> {
  try {
    const result = await ipcClient.invoke(channel, {
      ...input,
      path: typeof input.path === 'string' ? input.path : ctx.workingFolder
    })
    return encodeStructuredToolResult(
      result && typeof result === 'object' ? { ...(result as Record<string, unknown>) } : { result }
    )
  } catch (error) {
    return encodeStructuredToolResult({
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

const globHandler: ToolHandler = {
  definition: workspaceToolDefinition(WORKSPACE_PROTOCOL_TOOLS.Glob),
  execute: async (input, ctx) => invokeSearch(IPC.FS_GLOB, input, ctx),
  requiresApproval: () => WORKSPACE_PROTOCOL_TOOLS.Glob.requiresApproval,
  capability: {
    readOnly: true,
    sideEffectFree: true,
    parallelizable: true,
    riskLevel: 'low',
    requiresApproval: false,
    source: 'core',
    owner: 'search',
    projectScoped: true
  }
}

const grepHandler: ToolHandler = {
  definition: workspaceToolDefinition(WORKSPACE_PROTOCOL_TOOLS.Grep),
  execute: async (input, ctx) => invokeSearch(IPC.FS_GREP, input, ctx),
  requiresApproval: () => WORKSPACE_PROTOCOL_TOOLS.Grep.requiresApproval,
  capability: {
    readOnly: true,
    sideEffectFree: true,
    parallelizable: true,
    riskLevel: 'low',
    requiresApproval: false,
    source: 'core',
    owner: 'search',
    projectScoped: true
  }
}

export function registerSearchTools(): void {
  toolRegistry.register(globHandler)
  toolRegistry.register(grepHandler)
}
