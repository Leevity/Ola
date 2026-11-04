import { toolRegistry } from '../agent/tool-registry'
import { encodeBashToolResult } from './bash-output'
import type { ToolHandler } from './tool-types'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'
import {
  WORKSPACE_PROTOCOL_TOOLS,
  workspaceToolDefinition
} from '../../../../shared/tool-catalog/workspace-protocol'

const DEFAULT_COMMAND_TIMEOUT_MS = 600_000

const bashHandler: ToolHandler = {
  definition: workspaceToolDefinition(WORKSPACE_PROTOCOL_TOOLS.Bash),
  execute: async (input, ctx) => {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (!command) return encodeBashToolResult({ exitCode: 1, stderr: 'command is required' })
    const timeout =
      typeof input.timeout === 'number' && Number.isFinite(input.timeout)
        ? Math.max(1, Math.min(Math.trunc(input.timeout), 3_600_000))
        : DEFAULT_COMMAND_TIMEOUT_MS
    try {
      const result = await ipcClient.invoke(IPC.SHELL_EXEC, {
        command,
        timeout,
        cwd: ctx.workingFolder
      })
      return encodeBashToolResult(
        result && typeof result === 'object'
          ? { ...(result as Record<string, unknown>) }
          : { exitCode: 1, stderr: String(result) }
      )
    } catch (error) {
      return encodeBashToolResult({
        exitCode: 1,
        stderr: error instanceof Error ? error.message : String(error)
      })
    }
  },
  requiresApproval: (_input, ctx) => {
    if (ctx.channelPermissions) return !ctx.channelPermissions.allowShell
    return WORKSPACE_PROTOCOL_TOOLS.Bash.requiresApproval
  }
}

export function registerBashTools(): void {
  toolRegistry.register(bashHandler)
}
