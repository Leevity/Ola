import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { WorkspaceRootResolver } from './local-read-file'
import type { ToolDefinition } from './tool-executor'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT_BYTES = 64 * 1024
const GIT_TIMEOUT_MS = 10_000

function input(value: unknown): Record<string, never> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return {}
}

/** Reads Git status through a fixed command; model input never reaches a shell. */
export function createLocalGitStatusTool(
  workspaceRoot: string | WorkspaceRootResolver
): ToolDefinition {
  const root = async (context: Parameters<ToolDefinition['execute']>[1]): Promise<string> =>
    typeof workspaceRoot === 'string' ? workspaceRoot : await workspaceRoot(context)
  return {
    name: 'git_status',
    description: 'Show the current Git branch and changed files in the configured workspace.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: 'read',
    validate: input,
    resources: async (_value, context) => [await root(context)],
    execute: async (_value, context) => {
      const cwd = await root(context)
      try {
        const { stdout } = await execFileAsync('git', ['status', '--short', '--branch'], {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          signal: context.signal,
          windowsHide: true
        })
        const output = String(stdout)
        if (Buffer.byteLength(output) > MAX_GIT_OUTPUT_BYTES)
          throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
        return output || 'Working tree clean.'
      } catch (error) {
        context.signal.throwIfAborted()
        if (error instanceof RuntimeError) throw error
        throw new RuntimeError('GIT_STATUS_FAILED')
      }
    }
  }
}
