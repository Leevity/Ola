import { RuntimeError } from '../../shared/runtime/contracts'
import { executeLocalShell } from '../host/local-shell-executor'
import type { WorkspaceRootResolver } from './local-read-file'
import type { ToolDefinition } from './tool-executor'

type ShellInput = { command: string; timeoutMs: number }
const MAX_COMMAND_BYTES = 16 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000

function input(value: unknown): ShellInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => key !== 'command' && key !== 'timeoutMs'))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const command = item.command
  const timeoutValue = item.timeoutMs
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    Buffer.byteLength(command) > MAX_COMMAND_BYTES
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (
    timeoutValue !== undefined &&
    (typeof timeoutValue !== 'number' ||
      !Number.isSafeInteger(timeoutValue) ||
      timeoutValue < 1 ||
      timeoutValue > MAX_TIMEOUT_MS)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { command, timeoutMs: timeoutValue === undefined ? DEFAULT_TIMEOUT_MS : timeoutValue }
}

/** Runs an approved shell command only inside Main-approved workspace root. */
export function createLocalShellCommandTool(
  workspaceRoot: string | WorkspaceRootResolver
): ToolDefinition {
  const root = async (context: Parameters<ToolDefinition['execute']>[1]): Promise<string> =>
    typeof workspaceRoot === 'string' ? workspaceRoot : await workspaceRoot(context)
  return {
    name: 'run_shell_command',
    description: 'Run an approved shell command in the configured workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS }
      },
      required: ['command'],
      additionalProperties: false
    },
    effect: 'write',
    validate: input,
    resources: async (_value, context) => [await root(context)],
    execute: async (value, context) => {
      const request = value as ShellInput
      const result = await executeLocalShell({
        command: request.command,
        cwd: await root(context),
        timeoutMs: request.timeoutMs,
        env: {},
        maxOutputBytes: MAX_OUTPUT_BYTES,
        signal: context.signal
      })
      context.signal.throwIfAborted()
      if (result.outputLimitExceeded) throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut
      }
    }
  }
}
