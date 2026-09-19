import { toolRegistry } from '../agent/tool-registry'
import { encodeBashToolResult } from './bash-output'
import type { ToolHandler } from './tool-types'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'

const DEFAULT_COMMAND_TIMEOUT_MS = 600_000

const bashHandler: ToolHandler = {
  definition: {
    name: 'Bash',
    description: 'Execute a shell command',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: {
          type: 'number',
          description: `Timeout in milliseconds (max 3600000, default ${DEFAULT_COMMAND_TIMEOUT_MS})`
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Run command in background without blocking; if omitted, long-running commands are auto-detected'
        },
        force_foreground: {
          type: 'boolean',
          description:
            'Force foreground execution for long-running commands (default false; use only when necessary)'
        },
        description: { type: 'string', description: '5-10 word description of the command' }
      },
      required: ['command']
    }
  },
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
        cwd: ctx.workingFolder,
        shell: typeof input.shell === 'string' ? input.shell : undefined
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
    return true
  }
}

export function registerBashTools(): void {
  toolRegistry.register(bashHandler)
}
