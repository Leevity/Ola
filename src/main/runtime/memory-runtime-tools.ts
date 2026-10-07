import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolContext, ToolDefinition } from '../../runtime/tools/tool-executor'
import { olaDataRoot } from '../lib/ola-data-root'
import { workspaceMemoryDataRoot } from '../lib/workspace-memory-path'

const MEMORY_FILES = ['memory_summary.md', 'MEMORY.md', 'USER.md', 'SOUL.md'] as const
const MAX_MEMORY_FILE_BYTES = 256 * 1024
type MemoryScope = 'global' | 'project' | 'both'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function inRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function parseScope(value: unknown): MemoryScope {
  if (value === undefined) return 'both'
  if (value === 'global' || value === 'project' || value === 'both') return value
  throw new RuntimeError('INVALID_TOOL_INPUT')
}

async function projectMemoryRoot(context: ToolContext): Promise<string | undefined> {
  const projectRoot = context.run.workingDirectory
  if (!projectRoot || !isAbsolute(projectRoot)) return undefined
  const canonicalProjectRoot = await realpath(projectRoot).catch(() => undefined)
  if (!canonicalProjectRoot || !(await stat(canonicalProjectRoot).catch(() => null))?.isDirectory())
    return undefined
  const globalHome = workspaceMemoryDataRoot(olaDataRoot(), context.run.workspaceId)
  const root = resolve(canonicalProjectRoot, '.agents')
  if (context.run.workspaceId === 'local-personal') return root
  const key = globalHome.split(/[\\/]/).at(-1)
  if (!key || !/^[0-9a-f]{64}$/.test(key)) return undefined
  return join(root, 'workspaces', key)
}

async function readMemoryFile(root: string, file: string): Promise<string | undefined> {
  const candidate = resolve(root, file)
  if (!inRoot(resolve(root), candidate)) throw new RuntimeError('MEMORY_PATH_FORBIDDEN')
  try {
    const rootInfo = await lstat(root)
    const fileInfo = await lstat(candidate)
    if (rootInfo.isSymbolicLink() || fileInfo.isSymbolicLink() || !fileInfo.isFile())
      throw new RuntimeError('MEMORY_PATH_FORBIDDEN')
    if (fileInfo.size > MAX_MEMORY_FILE_BYTES) throw new RuntimeError('MEMORY_FILE_TOO_LARGE')
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(candidate)])
    if (!inRoot(realRoot, realFile)) throw new RuntimeError('MEMORY_PATH_FORBIDDEN')
    return await readFile(realFile, 'utf8')
  } catch (error) {
    if (error instanceof RuntimeError) throw error
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw new RuntimeError('MEMORY_READ_FAILED')
  }
}

function lines(content: string | undefined): Array<{ line: number; text: string }> {
  return (content ?? '').split(/\r?\n/).map((text, index) => ({ line: index + 1, text }))
}

function makeTool(
  name: 'MemoryList' | 'MemoryRead' | 'MemorySearch',
  description: string,
  inputSchema: Record<string, unknown>,
  validate: (input: unknown) => Record<string, unknown>,
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<unknown>
): ToolDefinition {
  return {
    name,
    description,
    inputSchema,
    effect: 'read',
    validate,
    resources: async () => [],
    execute: async (input, context) => await execute(input as Record<string, unknown>, context)
  }
}

const scopeSchema = { type: 'string', enum: ['global', 'project', 'both'] }

export function createMemoryRuntimeTools(): ToolDefinition[] {
  const roots = async (context: ToolContext, scope: MemoryScope) => {
    const global = workspaceMemoryDataRoot(olaDataRoot(), context.run.workspaceId)
    const project = await projectMemoryRoot(context)
    return [
      ...(scope === 'project' ? [] : [{ scope: 'global' as const, root: global }]),
      ...(scope === 'global' || !project ? [] : [{ scope: 'project' as const, root: project }])
    ]
  }
  return [
    makeTool(
      'MemoryList',
      'List available memory roots in the current workspace and approved project.',
      { type: 'object', properties: { scope: scopeSchema }, additionalProperties: false },
      (value) => {
        const input = object(value)
        if (Object.keys(input).some((key) => key !== 'scope'))
          throw new RuntimeError('INVALID_TOOL_INPUT')
        return { scope: parseScope(input.scope) }
      },
      async (input, context) => ({
        roots: (await roots(context, input.scope as MemoryScope)).map(({ scope, root }) => ({
          scope,
          memoryRootId: root
        }))
      })
    ),
    makeTool(
      'MemoryRead',
      'Read fixed, approved memory files with line numbers for citations.',
      {
        type: 'object',
        properties: {
          scope: scopeSchema,
          memoryRootId: { type: 'string' },
          file: { type: 'string', enum: MEMORY_FILES }
        },
        additionalProperties: false
      },
      (value) => {
        const input = object(value)
        if (Object.keys(input).some((key) => !['scope', 'memoryRootId', 'file'].includes(key)))
          throw new RuntimeError('INVALID_TOOL_INPUT')
        if (input.memoryRootId !== undefined && typeof input.memoryRootId !== 'string')
          throw new RuntimeError('INVALID_TOOL_INPUT')
        if (
          input.file !== undefined &&
          !MEMORY_FILES.includes(input.file as (typeof MEMORY_FILES)[number])
        )
          throw new RuntimeError('INVALID_TOOL_INPUT')
        return {
          scope: parseScope(input.scope),
          ...(input.memoryRootId ? { memoryRootId: input.memoryRootId } : {}),
          file: input.file ?? 'memory_summary.md'
        }
      },
      async (input, context) => {
        const file = input.file as string
        const selectedRoots = (await roots(context, input.scope as MemoryScope)).filter(
          ({ root }) => !input.memoryRootId || root === input.memoryRootId
        )
        if (input.memoryRootId && !selectedRoots.length)
          throw new RuntimeError('MEMORY_ROOT_FORBIDDEN')
        const results = await Promise.all(
          selectedRoots.map(async ({ scope, root }) => ({
            scope,
            memoryRootId: root,
            file,
            path: join(root, file),
            lines: lines(await readMemoryFile(root, file))
          }))
        )
        return { results }
      }
    ),
    makeTool(
      'MemorySearch',
      'Search approved memory files in the current workspace and project.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 512 },
          scope: scopeSchema,
          limit: { type: 'integer', minimum: 1, maximum: 100 }
        },
        required: ['query'],
        additionalProperties: false
      },
      (value) => {
        const input = object(value)
        if (Object.keys(input).some((key) => !['query', 'scope', 'limit'].includes(key)))
          throw new RuntimeError('INVALID_TOOL_INPUT')
        if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 512)
          throw new RuntimeError('INVALID_TOOL_INPUT')
        if (
          input.limit !== undefined &&
          (!Number.isSafeInteger(input.limit) ||
            (input.limit as number) < 1 ||
            (input.limit as number) > 100)
        )
          throw new RuntimeError('INVALID_TOOL_INPUT')
        return {
          query: input.query.trim(),
          scope: parseScope(input.scope),
          limit: input.limit ?? 20
        }
      },
      async (input, context) => {
        const query = (input.query as string).toLocaleLowerCase()
        const files = await Promise.all(
          (await roots(context, input.scope as MemoryScope)).flatMap(({ scope, root }) =>
            MEMORY_FILES.map(async (file) => ({
              scope,
              root,
              file,
              content: await readMemoryFile(root, file)
            }))
          )
        )
        const results = files
          .flatMap(({ scope, root, file, content }) =>
            lines(content).flatMap(({ line, text }) =>
              text.toLocaleLowerCase().includes(query)
                ? [{ scope, memoryRootId: root, path: join(root, file), line, text }]
                : []
            )
          )
          .slice(0, input.limit as number)
        return { results }
      }
    )
  ]
}
