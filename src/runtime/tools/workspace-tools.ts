import { RuntimeError } from '../../shared/runtime/contracts'
import { lstat, readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { globLocalFiles, readLocalFile } from '../host/local-file-service'
import { createLocalCreateFileTool } from './local-create-file'
import { createLocalGlobFilesTool } from './local-find-files'
import { createLocalListDirectoryTool } from './local-list-directory'
import {
  confinedWorkspacePath,
  createLocalReadFileTool,
  type WorkspaceRootResolver
} from './local-read-file'
import { createLocalShellCommandTool } from './local-shell-command'
import { createLocalWriteFileTool } from './local-write-file'
import type { ToolDefinition } from './tool-executor'

type LegacyRecord = Record<string, unknown>

function record(value: unknown): LegacyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as LegacyRecord
}

function only(value: LegacyRecord, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new RuntimeError('INVALID_TOOL_INPUT')
}

function legacyPath(value: LegacyRecord): string {
  const path = value.file_path ?? value.path
  if (
    typeof path !== 'string' ||
    !path.trim() ||
    (value.file_path !== undefined && value.path !== undefined && value.file_path !== value.path)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return path
}

/**
 * Gives an existing safe TS primitive its established Agent protocol name.
 * The normalizer runs before the primitive's validator, so no legacy field
 * reaches a filesystem or shell operation unvalidated.
 */
function legacyAlias(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  target: ToolDefinition,
  normalize: (input: unknown) => unknown
): ToolDefinition {
  return {
    name,
    description,
    inputSchema,
    effect: target.effect,
    validate: (input) => target.validate(normalize(input)),
    resources: (input, context) => target.resources(input, context),
    execute: (input, context) => target.execute(input, context)
  }
}

type LegacyReadInput = { path: string; offset: number; limit: number }

function legacyReadInput(input: unknown): LegacyReadInput {
  const value = record(input)
  only(value, ['file_path', 'path', 'offset', 'limit'])
  const offset = value.offset ?? 1
  const limit = value.limit ?? 2_000
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(limit) ||
    (offset as number) < 1 ||
    (limit as number) < 1
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return {
    path: legacyPath(value),
    offset: offset as number,
    limit: Math.min(limit as number, 2_000)
  }
}

/**
 * Legacy `Read` uses the Worker-compatible line-numbered paging protocol.
 * Resource resolution remains delegated to the confined TS file primitive so
 * `offset` and `limit` can never bypass workspace realpath checks.
 */
export function createLegacyReadTool(root: string | WorkspaceRootResolver): ToolDefinition {
  const confined = createLocalReadFileTool(root)
  return {
    name: 'Read',
    description: 'Read a UTF-8 text file inside the configured workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 2_000 }
      },
      additionalProperties: false
    },
    effect: 'read',
    validate: legacyReadInput,
    resources: (input, context) =>
      confined.resources({ path: (input as LegacyReadInput).path }, context),
    execute: async (input, context) => {
      const value = input as LegacyReadInput
      const [path] = await confined.resources({ path: value.path }, context)
      const result = await readLocalFile({
        path,
        offset: value.offset,
        limit: value.limit,
        raw: false,
        maxFileReadBytes: 32 * 1024,
        maxImageReadBytes: 32 * 1024
      })
      if (typeof result !== 'string') throw new RuntimeError('TOOL_READ_FAILED')
      return result
    }
  }
}

/** Legacy `LS` name backed by the confined TS directory lister. */
export function createLegacyListDirectoryTool(
  root: string | WorkspaceRootResolver
): ToolDefinition {
  return legacyAlias(
    'LS',
    'List entries inside the configured workspace directory.',
    {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500 }
      },
      additionalProperties: false
    },
    createLocalListDirectoryTool(root),
    (input) => {
      const value = record(input)
      only(value, ['path', 'limit'])
      return value
    }
  )
}

/** Legacy `Glob` name backed by the bounded TS glob implementation. */
export function createLegacyGlobTool(root: string | WorkspaceRootResolver): ToolDefinition {
  return legacyAlias(
    'Glob',
    'Find workspace files with a glob pattern.',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        hidden: { type: 'boolean' },
        respectGitignore: { type: 'boolean' },
        maxDepth: { type: ['integer', 'null'], minimum: 0, maximum: 50 }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    createLocalGlobFilesTool(root),
    (input) => {
      const value = record(input)
      only(value, ['pattern', 'path', 'limit', 'hidden', 'respectGitignore', 'maxDepth'])
      return value
    }
  )
}

/** Legacy `Bash` name backed by the Main-approved workspace shell executor. */
export function createLegacyBashTool(root: string | WorkspaceRootResolver): ToolDefinition {
  return legacyAlias(
    'Bash',
    'Run an approved shell command in the configured workspace.',
    {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer', minimum: 1, maximum: 120000 }
      },
      required: ['command'],
      additionalProperties: false
    },
    createLocalShellCommandTool(root),
    (input) => {
      const value = record(input)
      only(value, ['command', 'timeout'])
      return {
        command: value.command,
        ...(value.timeout === undefined ? {} : { timeoutMs: value.timeout })
      }
    }
  )
}

/** Windows PowerShell alias backed by Main's approved, workspace-confined shell executor. */
export function createLegacyPowerShellTool(root: string | WorkspaceRootResolver): ToolDefinition {
  const target = createLocalShellCommandTool(root, {
    shell: 'powershell.exe',
    defaultTimeoutMs: 600_000,
    maxTimeoutMs: 3_600_000
  })
  return legacyAlias(
    'PowerShell',
    'Execute a command through Windows PowerShell in the configured workspace.',
    {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer', minimum: 1, maximum: 3_600_000 }
      },
      required: ['command'],
      additionalProperties: false
    },
    target,
    (input) => {
      const value = record(input)
      only(value, ['command', 'timeout'])
      return {
        command: value.command,
        ...(value.timeout === undefined ? {} : { timeoutMs: value.timeout })
      }
    }
  )
}

/** Matches the existing Monitor implementation, which runs a foreground command. */
export function createLegacyMonitorTool(root: string | WorkspaceRootResolver): ToolDefinition {
  const target = createLocalShellCommandTool(root, {
    defaultTimeoutMs: 600_000,
    maxTimeoutMs: 600_000
  })
  return legacyAlias(
    'Monitor',
    'Run and monitor a command in the configured workspace.',
    {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string', maxLength: 512 }
      },
      required: ['command'],
      additionalProperties: false
    },
    target,
    (input) => {
      const value = record(input)
      only(value, ['command', 'description'])
      if (
        value.description !== undefined &&
        (typeof value.description !== 'string' || value.description.length > 512)
      )
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return { command: value.command }
    }
  )
}

type LegacyWriteInput = { path: string; content: string }

function legacyWriteInput(input: unknown): LegacyWriteInput {
  const value = record(input)
  only(value, ['file_path', 'path', 'content'])
  if (typeof value.content !== 'string') throw new RuntimeError('INVALID_TOOL_INPUT')
  return { path: legacyPath(value), content: value.content }
}

/**
 * Legacy `Write` creates a new file once or atomically replaces an existing
 * regular file. Both branches use the same constrained parent/root checks.
 */
export function createLegacyWriteTool(root: string | WorkspaceRootResolver): ToolDefinition {
  const create = createLocalCreateFileTool(root)
  const replace = createLocalWriteFileTool(root)
  return {
    name: 'Write',
    description: 'Create or replace a UTF-8 text file inside the configured workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['content'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (input) => {
      const value = legacyWriteInput(input)
      // The create primitive gives this branch a stable, confined resource id
      // even when the target does not yet exist.
      return create.validate(value) as LegacyWriteInput
    },
    resources: (input, context) => create.resources(input, context),
    execute: async (input, context) => {
      const value = input as LegacyWriteInput
      const target = await create.resources(value, context).then(([path]) => path)
      const exists = await lstat(target).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false
          throw error
        }
      )
      return exists ? await replace.execute(value, context) : await create.execute(value, context)
    }
  }
}

type LegacyEditInput = { path: string; oldString: string; newString: string; replaceAll: boolean }

function legacyEditInput(input: unknown): LegacyEditInput {
  const value = record(input)
  only(value, ['file_path', 'path', 'old_string', 'new_string', 'replace_all'])
  if (
    typeof value.old_string !== 'string' ||
    !value.old_string ||
    typeof value.new_string !== 'string' ||
    value.old_string === value.new_string ||
    (value.replace_all !== undefined && typeof value.replace_all !== 'boolean')
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return {
    path: legacyPath(value),
    oldString: value.old_string,
    newString: value.new_string,
    replaceAll: value.replace_all === true
  }
}

/** Exact legacy `Edit` semantics, including refusal of ambiguous one-off replacements. */
export function createLegacyEditTool(root: string | WorkspaceRootResolver): ToolDefinition {
  const read = createLocalReadFileTool(root)
  const write = createLegacyWriteTool(root)
  return {
    name: 'Edit',
    description: 'Replace an exact string in a UTF-8 workspace file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['old_string', 'new_string'],
      additionalProperties: false
    },
    effect: 'write',
    validate: legacyEditInput,
    resources: (input, context) =>
      read.resources({ path: (input as LegacyEditInput).path }, context),
    execute: async (input, context) => {
      const value = input as LegacyEditInput
      const source = (await read.execute({ path: value.path }, context)) as string
      const occurrences = source.split(value.oldString).length - 1
      if (!occurrences) throw new RuntimeError('EDIT_STRING_NOT_FOUND')
      if (occurrences > 1 && !value.replaceAll) throw new RuntimeError('EDIT_STRING_AMBIGUOUS')
      const content = value.replaceAll
        ? source.split(value.oldString).join(value.newString)
        : source.replace(value.oldString, value.newString)
      return await write.execute({ path: value.path, content }, context)
    }
  }
}

type LegacyNotebookEditInput = {
  path: string
  cellId?: string
  cellIndex: number
  mode: 'replace' | 'insert' | 'delete'
  source?: string
  cellType: 'code' | 'markdown' | 'raw'
}

function legacyNotebookEditInput(input: unknown): LegacyNotebookEditInput {
  const value = record(input)
  only(value, [
    'notebook_path',
    'file_path',
    'cell_id',
    'cell_index',
    'mode',
    'new_source',
    'source',
    'cell_type'
  ])
  const path = value.notebook_path ?? value.file_path
  if (
    typeof path !== 'string' ||
    !path.trim() ||
    path.length > 4096 ||
    (value.notebook_path !== undefined &&
      value.file_path !== undefined &&
      value.notebook_path !== value.file_path)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const cellId = value.cell_id
  if (cellId !== undefined && (typeof cellId !== 'string' || !cellId.trim() || cellId.length > 256))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const cellIndex = value.cell_index ?? 0
  if (
    !Number.isSafeInteger(cellIndex) ||
    (cellIndex as number) < 0 ||
    (cellIndex as number) > 100_000
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const mode = value.mode ?? 'replace'
  if (mode !== 'replace' && mode !== 'insert' && mode !== 'delete')
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (cellId === undefined && value.cell_index === undefined && mode !== 'insert')
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const source = value.new_source ?? value.source
  if (
    source !== undefined &&
    (typeof source !== 'string' || Buffer.byteLength(source) > 128 * 1024)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (mode !== 'delete' && typeof source !== 'string') throw new RuntimeError('INVALID_TOOL_INPUT')
  const cellType = value.cell_type ?? 'code'
  if (cellType !== 'code' && cellType !== 'markdown' && cellType !== 'raw')
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return {
    path,
    ...(typeof cellId === 'string' ? { cellId } : {}),
    cellIndex: cellIndex as number,
    mode,
    ...(typeof source === 'string' ? { source } : {}),
    cellType
  }
}

/** Jupyter edits use workspace confinement and the same authorization path as Edit. */
export function createLegacyNotebookEditTool(root: string | WorkspaceRootResolver): ToolDefinition {
  const read = createLocalReadFileTool(root)
  const write = createLegacyWriteTool(root)
  return {
    name: 'NotebookEdit',
    description: 'Edit a Jupyter notebook cell by index or cell_id inside the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string' },
        file_path: { type: 'string' },
        cell_id: { type: 'string' },
        cell_index: { type: 'integer', minimum: 0, maximum: 100_000 },
        mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
        new_source: { type: 'string' },
        source: { type: 'string' },
        cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'] }
      },
      additionalProperties: false
    },
    effect: 'write',
    validate: legacyNotebookEditInput,
    resources: (input, context) =>
      read.resources({ path: (input as LegacyNotebookEditInput).path }, context),
    execute: async (rawInput, context) => {
      const input = rawInput as LegacyNotebookEditInput
      const content = await read.execute({ path: input.path }, context)
      if (typeof content !== 'string') throw new RuntimeError('TOOL_READ_FAILED')
      let notebook: { cells: Array<Record<string, unknown>>; [key: string]: unknown }
      try {
        const parsed: unknown = JSON.parse(content)
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !Array.isArray((parsed as { cells?: unknown }).cells)
        )
          throw new RuntimeError('INVALID_NOTEBOOK')
        notebook = parsed as { cells: Array<Record<string, unknown>>; [key: string]: unknown }
      } catch (error) {
        if (error instanceof RuntimeError) throw error
        throw new RuntimeError('INVALID_NOTEBOOK')
      }
      const index = input.cellId
        ? notebook.cells.findIndex((cell) => cell.id === input.cellId)
        : input.cellIndex
      if (input.mode !== 'insert' && (index < 0 || index >= notebook.cells.length))
        throw new RuntimeError('NOTEBOOK_CELL_NOT_FOUND')
      if (input.mode === 'delete') {
        notebook.cells.splice(index, 1)
      } else {
        const sourceLines = (input.source ?? '').split(/(?<=\n)/)
        if (input.mode === 'insert') {
          notebook.cells.splice(input.cellIndex, 0, {
            cell_type: input.cellType,
            id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
            metadata: {},
            source: sourceLines
          })
        } else {
          notebook.cells[index] = {
            ...notebook.cells[index],
            cell_type: input.cellType,
            source: sourceLines
          }
        }
      }
      return await write.execute(
        { path: input.path, content: `${JSON.stringify(notebook, null, 2)}\n` },
        context
      )
    }
  }
}

type LegacyGrepInput = {
  pattern: string
  path: string
  glob?: string
  limit: number
  maxCount?: number
  caseSensitive: boolean
  literal: boolean
  word: boolean
  line: boolean
  invertMatch: boolean
  outputMode: 'files_with_matches' | 'matches' | 'count'
}

const LEGACY_GREP_FIELDS = [
  'pattern',
  'path',
  'glob',
  'limit',
  'head_limit',
  'maxResults',
  'maxCount',
  'ignoreCase',
  'caseSensitive',
  'smartCase',
  'literal',
  'fixed',
  'fixedStrings',
  'word',
  'line',
  'invertMatch',
  'output_mode',
  'outputMode'
] as const

function finiteInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || !Number.isInteger(value) || (value as number) < 1)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return Math.min(value as number, maximum)
}

function legacyGrepInput(input: unknown): LegacyGrepInput {
  const value = record(input)
  only(value, LEGACY_GREP_FIELDS)
  if (typeof value.pattern !== 'string' || !value.pattern.trim())
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (value.path !== undefined && (typeof value.path !== 'string' || !value.path.trim()))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (value.glob !== undefined && (typeof value.glob !== 'string' || !value.glob.trim()))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  for (const field of [
    'ignoreCase',
    'caseSensitive',
    'smartCase',
    'literal',
    'fixed',
    'fixedStrings',
    'word',
    'line',
    'invertMatch'
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean')
      throw new RuntimeError('INVALID_TOOL_INPUT')
  }
  const requestedMode = value.output_mode ?? value.outputMode
  const outputMode =
    requestedMode === undefined || requestedMode === 'files_with_matches'
      ? 'files_with_matches'
      : requestedMode === 'content' || requestedMode === 'matches'
        ? 'matches'
        : requestedMode === 'count'
          ? 'count'
          : (() => {
              throw new RuntimeError('INVALID_TOOL_INPUT')
            })()
  if (value.ignoreCase === true && value.caseSensitive === true)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const smartCase = value.smartCase === true
  const caseSensitive =
    value.caseSensitive === true
      ? true
      : value.ignoreCase === true
        ? false
        : smartCase
          ? /[A-Z]/.test(value.pattern)
          : true
  return {
    pattern: value.pattern,
    path: value.path ?? '.',
    ...(value.glob ? { glob: value.glob } : {}),
    limit: finiteInteger(value.limit ?? value.head_limit ?? value.maxResults, 100, 200),
    ...(value.maxCount === undefined ? {} : { maxCount: finiteInteger(value.maxCount, 1, 200) }),
    caseSensitive,
    literal: value.literal === true || value.fixed === true || value.fixedStrings === true,
    word: value.word === true,
    line: value.line === true,
    invertMatch: value.invertMatch === true,
    outputMode
  }
}

function grepMatcher(input: LegacyGrepInput): RegExp {
  const escaped = input.literal
    ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : input.pattern
  const source = `${input.line ? '^' : ''}${input.word ? '\\b' : ''}${escaped}${input.word ? '\\b' : ''}${input.line ? '$' : ''}`
  try {
    return new RegExp(source, input.caseSensitive ? '' : 'i')
  } catch {
    throw new RuntimeError('INVALID_TOOL_INPUT')
  }
}

function globFilter(pattern: string | undefined, path: string): boolean {
  if (!pattern) return true
  const basename = path.split('/').at(-1) ?? path
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // Keep sentinels while processing single stars: replacing `**` with
    // `.*` first would otherwise have its generated star rewritten again.
    // A leading `**/` also matches files directly in the search root.
    .replace(/\*\*\//g, '@@OLA_GLOBSTAR_SLASH@@')
    .replace(/\*\*/g, '@@OLA_GLOBSTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll('@@OLA_GLOBSTAR_SLASH@@', '(?:.*/)?')
    .replaceAll('@@OLA_GLOBSTAR@@', '.*')
  const expression = new RegExp(`^${escaped}$`, 'i')
  return expression.test(path) || expression.test(basename)
}

async function resolveLegacyWorkspacePath(
  root: string | WorkspaceRootResolver,
  path: string,
  context: Parameters<ToolDefinition['execute']>[1]
): Promise<string> {
  const workspace = typeof root === 'string' ? root : await root(context)
  return confinedWorkspacePath(workspace, path)
}

/**
 * Bounded TS implementation of legacy `Grep`. It deliberately accepts only
 * semantics that run locally and deterministically; unimplemented historical
 * Git and PCRE switches are rejected at validation instead of being ignored.
 */
export function createLegacyGrepTool(root: string | WorkspaceRootResolver): ToolDefinition {
  return {
    name: 'Grep',
    description: 'Search UTF-8 workspace files using a bounded regular expression.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        head_limit: { type: 'integer', minimum: 1, maximum: 200 },
        maxResults: { type: 'integer', minimum: 1, maximum: 200 },
        maxCount: { type: 'integer', minimum: 1, maximum: 200 },
        ignoreCase: { type: 'boolean' },
        caseSensitive: { type: 'boolean' },
        smartCase: { type: 'boolean' },
        literal: { type: 'boolean' },
        fixed: { type: 'boolean' },
        fixedStrings: { type: 'boolean' },
        word: { type: 'boolean' },
        line: { type: 'boolean' },
        invertMatch: { type: 'boolean' },
        output_mode: { enum: ['files_with_matches', 'content', 'count'] },
        outputMode: { enum: ['files_with_matches', 'matches', 'content', 'count'] }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    effect: 'read',
    validate: legacyGrepInput,
    resources: async (input, context) => [
      await resolveLegacyWorkspacePath(root, (input as LegacyGrepInput).path, context)
    ],
    execute: async (input, context) => {
      const value = input as LegacyGrepInput
      const searchRoot = await resolveLegacyWorkspacePath(root, value.path, context)
      const matcher = grepMatcher(value)
      const files = await globLocalFiles({
        path: searchRoot,
        pattern: '**/*',
        limit: 1_000,
        hidden: true,
        respectGitignore: true,
        maxDepth: 50
      })
      const rows: string[] = []
      for (const file of files.matches) {
        if (file.type !== 'file' || rows.length >= value.limit) continue
        const filePath = relative(searchRoot, file.path).replace(/\\/g, '/')
        if (!globFilter(value.glob, filePath)) continue
        const data = await readFile(file.path).catch(() => null)
        if (!data || data.byteLength > 64 * 1024 || data.includes(0)) continue
        const lines = data.toString('utf8').replace(/\r\n?/g, '\n').split('\n')
        const matches: Array<{ line: number; text: string }> = []
        for (let index = 0; index < lines.length; index += 1) {
          matcher.lastIndex = 0
          const matched = matcher.test(lines[index])
          if (value.invertMatch ? !matched : matched) {
            matches.push({ line: index + 1, text: lines[index].slice(0, 1_000) })
            if (matches.length >= (value.maxCount ?? 200)) break
          }
        }
        if (!matches.length) continue
        if (value.outputMode === 'files_with_matches') rows.push(filePath)
        else if (value.outputMode === 'count') rows.push(`${filePath}:${matches.length}`)
        else rows.push(...matches.map((item) => `${filePath}:${item.line}:${item.text}`))
      }
      let output = ''
      for (const row of rows) {
        const next = output ? `${output}\n${row}` : row
        if (Buffer.byteLength(next, 'utf8') > 64 * 1024) break
        output = next
      }
      return output
    }
  }
}
