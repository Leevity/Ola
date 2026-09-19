import { RuntimeError } from '../../shared/runtime/contracts'
import { globLocalFiles, searchLocalFiles } from '../host/local-file-service'
import { confinedWorkspacePath, type WorkspaceRootResolver } from './local-read-file'
import type { ToolDefinition } from './tool-executor'

const MAX_QUERY_LENGTH = 512
const MAX_PATTERN_LENGTH = 512
const MAX_RESULTS = 200
const MAX_OUTPUT_BYTES = 48 * 1024
const MAX_DEPTH = 50

type FindInput = { path: string; query: string; limit: number }
type GlobInput = {
  path: string
  pattern: string
  limit: number
  hidden: boolean
  respectGitignore: boolean
  maxDepth: number | null
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function pathAndLimit(value: Record<string, unknown>): { path: string; limit: number } {
  const path = value.path ?? '.'
  const limit = value.limit ?? 50
  if (
    typeof path !== 'string' ||
    !path.trim() ||
    path.length > 4096 ||
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_RESULTS
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { path, limit }
}

function findInput(value: unknown): FindInput {
  const item = record(value)
  if (Object.keys(item).some((key) => key !== 'path' && key !== 'query' && key !== 'limit'))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const { path, limit } = pathAndLimit(item)
  const query = item.query ?? ''
  if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { path, query, limit }
}

function globInput(value: unknown): GlobInput {
  const item = record(value)
  if (
    Object.keys(item).some(
      (key) =>
        key !== 'path' &&
        key !== 'pattern' &&
        key !== 'limit' &&
        key !== 'hidden' &&
        key !== 'respectGitignore' &&
        key !== 'maxDepth'
    )
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const { path, limit } = pathAndLimit(item)
  const pattern = item.pattern
  const hidden = item.hidden ?? false
  const respectGitignore = item.respectGitignore ?? true
  const maxDepth = item.maxDepth ?? null
  if (
    typeof pattern !== 'string' ||
    !pattern.trim() ||
    pattern.length > MAX_PATTERN_LENGTH ||
    typeof hidden !== 'boolean' ||
    typeof respectGitignore !== 'boolean' ||
    (maxDepth !== null &&
      (typeof maxDepth !== 'number' ||
        !Number.isSafeInteger(maxDepth) ||
        maxDepth < 0 ||
        maxDepth > MAX_DEPTH))
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { path, pattern, limit, hidden, respectGitignore, maxDepth }
}

function resultFits(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_OUTPUT_BYTES)
    throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
}

function resolveRoot(
  workspaceRoot: string | WorkspaceRootResolver,
  context: Parameters<ToolDefinition['execute']>[1]
) {
  return typeof workspaceRoot === 'string' ? Promise.resolve(workspaceRoot) : workspaceRoot(context)
}

/** Recursively finds workspace files without letting model input leave the approved root. */
export function createLocalFindFilesTool(
  workspaceRoot: string | WorkspaceRootResolver
): ToolDefinition {
  return {
    name: 'find_files',
    description: 'Recursively find workspace files by a filename or path query.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS }
      },
      additionalProperties: false
    },
    effect: 'read',
    validate: findInput,
    resources: async (value, context) => [
      await confinedWorkspacePath(
        await resolveRoot(workspaceRoot, context),
        (value as FindInput).path
      )
    ],
    execute: async (value, context) => {
      const request = value as FindInput
      const path = await confinedWorkspacePath(
        await resolveRoot(workspaceRoot, context),
        request.path
      )
      const result = await searchLocalFiles({ path, query: request.query, limit: request.limit })
      context.signal.throwIfAborted()
      resultFits(result)
      return result
    }
  }
}

/** Finds files with bounded Glob traversal and legacy-compatible ignore behavior. */
export function createLocalGlobFilesTool(
  workspaceRoot: string | WorkspaceRootResolver
): ToolDefinition {
  return {
    name: 'glob_files',
    description: 'Find workspace files with a glob pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        pattern: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
        hidden: { type: 'boolean' },
        respectGitignore: { type: 'boolean' },
        maxDepth: { type: ['integer', 'null'], minimum: 0, maximum: MAX_DEPTH }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    effect: 'read',
    validate: globInput,
    resources: async (value, context) => [
      await confinedWorkspacePath(
        await resolveRoot(workspaceRoot, context),
        (value as GlobInput).path
      )
    ],
    execute: async (value, context) => {
      const request = value as GlobInput
      const path = await confinedWorkspacePath(
        await resolveRoot(workspaceRoot, context),
        request.path
      )
      const result = await globLocalFiles({ ...request, path })
      context.signal.throwIfAborted()
      resultFits(result)
      return result
    }
  }
}
