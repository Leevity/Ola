import { toolRegistry } from '../agent/tool-registry'
import { encodeBashToolResult } from './bash-output'
import { IPC } from '../ipc/channels'
import { ipcClient } from '../ipc/ipc-client'
import type { ToolHandler } from './tool-types'

async function executeShellCommand(
  command: string,
  ctx: Parameters<NonNullable<ToolHandler['execute']>>[1],
  shell?: string,
  timeout?: number
) {
  if (!command) return encodeBashToolResult({ exitCode: 1, stderr: 'command is required' })
  try {
    const result = await ipcClient.invoke(IPC.SHELL_EXEC, {
      command,
      timeout: timeout ?? 600_000,
      cwd: ctx.workingFolder,
      ...(shell ? { shell } : {})
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
}

const powerShellHandler: ToolHandler = {
  definition: {
    name: 'PowerShell',
    description: 'Execute a command through Windows PowerShell.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds' }
      },
      required: ['command']
    }
  },
  execute: async (input, ctx) => {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    const timeout =
      typeof input.timeout === 'number' && Number.isFinite(input.timeout)
        ? Math.max(1, Math.min(Math.trunc(input.timeout), 3_600_000))
        : undefined
    return executeShellCommand(command, ctx, 'powershell.exe', timeout)
  },
  requiresApproval: () => true
}

const monitorHandler: ToolHandler = {
  definition: {
    name: 'Monitor',
    description: 'Run a background command and monitor its output through Ola background tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run in the background' },
        description: { type: 'string', description: 'Short monitor description' }
      },
      required: ['command']
    }
  },
  execute: async (input, ctx) => {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    return executeShellCommand(command, ctx)
  },
  requiresApproval: () => true
}

export function registerCodeCompatibleTools(): void {
  if (window.ola.desktop.platform === 'win32') {
    toolRegistry.register(powerShellHandler)
  }
  toolRegistry.register(monitorHandler)
}
