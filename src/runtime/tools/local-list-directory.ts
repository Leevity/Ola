import { readdir } from 'node:fs/promises'
import { RuntimeError } from '../../shared/runtime/contracts'
import { confinedWorkspacePath, type WorkspaceRootResolver } from './local-read-file'
import type { ToolDefinition } from './tool-executor'

type ListInput = { path: string; limit: number }
const MAX_LIST_ENTRIES = 500
// Tool results are persisted as runtime events before they reach a client. Keep
// this deliberately below the protocol frame limit even for unusual filenames.
const MAX_LIST_OUTPUT_BYTES = 48 * 1024

function input(value: unknown): ListInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => key !== 'path' && key !== 'limit'))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const path = item.path ?? '.'
  const limit = item.limit ?? 200
  if (
    typeof path !== 'string' ||
    !path.trim() ||
    path.length > 4096 ||
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_ENTRIES
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { path, limit }
}

/** Lists only entry metadata inside an already-approved workspace directory. */
export function createLocalListDirectoryTool(
  workspaceRoot: string | WorkspaceRootResolver
): ToolDefinition {
  const root = async (context: Parameters<ToolDefinition['execute']>[1]): Promise<string> =>
    typeof workspaceRoot === 'string' ? workspaceRoot : await workspaceRoot(context)
  return {
    name: 'list_directory',
    description: 'List entries inside the configured workspace directory.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }
    },
    effect: 'read',
    validate: input,
    resources: async (value, context) => [
      await confinedWorkspacePath(await root(context), (value as ListInput).path)
    ],
    execute: async (value, context) => {
      const target = await confinedWorkspacePath(await root(context), (value as ListInput).path)
      const entries = await readdir(target, { withFileTypes: true })
      const result = entries
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory()
            ? 'directory'
            : entry.isFile()
              ? 'file'
              : entry.isSymbolicLink()
                ? 'symlink'
                : 'other'
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, (value as ListInput).limit)
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_LIST_OUTPUT_BYTES)
        throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
      return result
    }
  }
}
