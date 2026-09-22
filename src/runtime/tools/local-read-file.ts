import { readFile } from 'node:fs/promises'
import { RuntimeError } from '../../shared/runtime/contracts'
import { resolveWorkspacePath } from '../../shared/security/path-policy'
import type { ToolDefinition } from './tool-executor'

type ReadInput = { path: string }
const MAX_TOOL_TEXT_BYTES = 32 * 1024

function input(value: unknown): ReadInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const keys = Object.keys(value)
  const path = (value as Record<string, unknown>).path
  if (
    keys.length !== 1 ||
    keys[0] !== 'path' ||
    typeof path !== 'string' ||
    !path.trim() ||
    path.length > 4096
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { path }
}

/**
 * Confine a tool-provided path to the workspace root. Delegates to the shared
 * path-policy so the runtime tools and the renderer capability layer share one
 * implementation. Denied paths throw the same TOOL_PATH_FORBIDDEN used before.
 */
export async function confinedWorkspacePath(root: string, path: string): Promise<string> {
  const result = resolveWorkspacePath(root, path, true)
  if (!result.allowed) throw new RuntimeError('TOOL_PATH_FORBIDDEN')
  return result.resolvedPath
}

export type WorkspaceRootResolver = (
  context: Parameters<ToolDefinition['execute']>[1]
) => Promise<string>

/** A host-owned read primitive; model paths are never trusted before realpath confinement. */
export function createLocalReadFileTool(
  workspaceRoot: string | WorkspaceRootResolver
): ToolDefinition {
  const root = async (context: Parameters<ToolDefinition['execute']>[1]): Promise<string> =>
    typeof workspaceRoot === 'string' ? workspaceRoot : await workspaceRoot(context)
  return {
    name: 'read_text_file',
    description: 'Read a UTF-8 text file inside the configured workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    effect: 'read',
    validate: input,
    resources: async (value, context) => [
      await confinedWorkspacePath(await root(context), (value as ReadInput).path)
    ],
    execute: async (value, context) => {
      const data = await readFile(
        await confinedWorkspacePath(await root(context), (value as ReadInput).path)
      )
      // Event JSON can expand control characters. Keep comfortably below the
      // journal's 256KB event limit so an executed read always has a result.
      if (data.byteLength > MAX_TOOL_TEXT_BYTES) throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
      return data.toString('utf8')
    }
  }
}
