import { open, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, relative } from 'node:path'
import { RuntimeError } from '../../shared/runtime/contracts'
import { confinedWorkspacePath, type WorkspaceRootResolver } from './local-read-file'
import type { ToolDefinition } from './tool-executor'

type WriteInput = { path: string; content: string }
const MAX_WRITE_BYTES = 128 * 1024

function input(value: unknown): WriteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const item = value as Record<string, unknown>
  if (
    Object.keys(item).length !== 2 ||
    typeof item.path !== 'string' ||
    !item.path.trim() ||
    item.path.length > 4096 ||
    typeof item.content !== 'string' ||
    Buffer.byteLength(item.content) > MAX_WRITE_BYTES
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { path: item.path, content: item.content }
}

/**
 * Replaces an existing regular text file through a same-directory temporary
 * file. The final rename replaces a symlink instead of following it, and an
 * approval therefore cannot turn into a write outside the workspace.
 */
export function createLocalWriteFileTool(
  workspaceRoot: string | WorkspaceRootResolver
): ToolDefinition {
  const root = async (context: Parameters<ToolDefinition['execute']>[1]): Promise<string> =>
    typeof workspaceRoot === 'string' ? workspaceRoot : await workspaceRoot(context)
  return {
    name: 'write_text_file',
    description: 'Replace an existing UTF-8 text file inside the configured workspace.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false
    },
    effect: 'write',
    validate: input,
    resources: async (value, context) => [
      await confinedWorkspacePath(await root(context), (value as WriteInput).path)
    ],
    execute: async (value, context) => {
      const request = value as WriteInput
      let handle: Awaited<ReturnType<typeof open>> | undefined
      let temporary: string | undefined
      try {
        context.signal.throwIfAborted()
        const workspace = await realpath(await root(context))
        const target = await confinedWorkspacePath(workspace, request.path)
        const targetStat = await stat(target)
        if (!targetStat.isFile()) throw new RuntimeError('TOOL_WRITE_FAILED')
        temporary = `${dirname(target)}/.${basename(target)}.${crypto.randomUUID()}.ola-tmp`
        handle = await open(temporary, 'wx', targetStat.mode & 0o777)
        await handle.writeFile(request.content, { encoding: 'utf8', signal: context.signal })
        await handle.sync()
        await handle.close()
        handle = undefined
        context.signal.throwIfAborted()
        await rename(temporary, target)
        temporary = undefined
        return {
          path: relative(workspace, target).replaceAll('\\', '/'),
          bytes: Buffer.byteLength(request.content),
          replaced: true
        }
      } catch (error) {
        context.signal.throwIfAborted()
        if (error instanceof RuntimeError) throw error
        throw new RuntimeError('TOOL_WRITE_FAILED')
      } finally {
        await handle?.close().catch(() => undefined)
        if (temporary) await rm(temporary, { force: true }).catch(() => undefined)
      }
    }
  }
}
