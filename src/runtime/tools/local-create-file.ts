import { open, realpath } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from './tool-executor'
import type { WorkspaceRootResolver } from './local-read-file'

type CreateInput = { path: string; content: string }
const MAX_CREATE_BYTES = 128 * 1024

function input(value: unknown): CreateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => key !== 'path' && key !== 'content'))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (
    typeof item.path !== 'string' ||
    !item.path.trim() ||
    item.path.length > 4096 ||
    typeof item.content !== 'string' ||
    Buffer.byteLength(item.content) > MAX_CREATE_BYTES
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { path: item.path, content: item.content }
}

/**
 * Resolves a new leaf below a real workspace parent. The parent must already
 * exist, and `wx` later guarantees that this tool never overwrites a file.
 */
export async function confinedWorkspaceCreatePath(root: string, path: string): Promise<string> {
  const rootPath = await realpath(root)
  const requested = resolve(rootPath, path)
  const lexical = relative(rootPath, requested)
  if (
    !lexical ||
    lexical === '..' ||
    lexical.startsWith(`..${sep}`) ||
    resolve(rootPath, lexical) !== requested
  )
    throw new RuntimeError('TOOL_PATH_FORBIDDEN')
  const parent = await realpath(dirname(requested))
  const outside = relative(rootPath, parent)
  if (outside === '..' || outside.startsWith(`..${sep}`) || resolve(rootPath, outside) !== parent)
    throw new RuntimeError('TOOL_PATH_FORBIDDEN')
  return resolve(parent, basename(requested))
}

/** Creates a UTF-8 text file once; editing or replacing existing files stays unavailable. */
export function createLocalCreateFileTool(
  workspaceRoot: string | WorkspaceRootResolver
): ToolDefinition {
  const root = async (context: Parameters<ToolDefinition['execute']>[1]): Promise<string> =>
    typeof workspaceRoot === 'string' ? workspaceRoot : await workspaceRoot(context)
  return {
    name: 'create_text_file',
    description:
      'Create a new UTF-8 text file inside the configured workspace. Existing files are never replaced.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false
    },
    effect: 'write',
    validate: input,
    resources: async (value, context) => [
      await confinedWorkspaceCreatePath(await root(context), (value as CreateInput).path)
    ],
    execute: async (value, context) => {
      const request = value as CreateInput
      const target = await confinedWorkspaceCreatePath(await root(context), request.path)
      context.signal.throwIfAborted()
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        // `wx` refuses an existing file (including a final-path symlink), so
        // approval can never turn into an implicit overwrite.
        handle = await open(target, 'wx', 0o600)
        await handle.writeFile(request.content, { encoding: 'utf8', signal: context.signal })
        await handle.sync()
        return {
          path: relative(await realpath(await root(context)), target),
          bytes: Buffer.byteLength(request.content)
        }
      } catch (error) {
        context.signal.throwIfAborted()
        if (error instanceof RuntimeError) throw error
        throw new RuntimeError('TOOL_WRITE_FAILED')
      } finally {
        await handle?.close()
      }
    }
  }
}
