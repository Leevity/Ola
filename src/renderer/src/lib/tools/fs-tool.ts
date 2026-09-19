import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'

function resolveWorkspacePath(value: unknown, workingFolder?: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.trim().replace(/\\/g, '/')
  if (/^(?:[A-Za-z]:\/|\/)/.test(normalized)) return normalized
  const base = workingFolder?.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return base ? `${base}/${normalized.replace(/^\/+/, '')}` : null
}

async function readFile(
  input: Record<string, unknown>,
  ctx: Parameters<ToolHandler['execute']>[1]
) {
  const path = resolveWorkspacePath(input.file_path, ctx.workingFolder)
  if (!path)
    return encodeStructuredToolResult({
      error: 'file_path must be absolute or use a working folder'
    })
  try {
    const result = await ipcClient.invoke(IPC.FS_READ_FILE, {
      path,
      offset: typeof input.offset === 'number' ? Math.max(1, Math.trunc(input.offset)) : 1,
      limit: typeof input.limit === 'number' ? Math.max(1, Math.trunc(input.limit)) : 2_000,
      raw: false
    })
    if (typeof result === 'string') return result
    return encodeStructuredToolResult(
      result && typeof result === 'object' ? { ...(result as Record<string, unknown>) } : { result }
    )
  } catch (error) {
    return encodeStructuredToolResult({
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function listDirectory(
  input: Record<string, unknown>,
  ctx: Parameters<ToolHandler['execute']>[1]
) {
  const path = resolveWorkspacePath(input.path ?? '.', ctx.workingFolder)
  if (!path)
    return encodeStructuredToolResult({ error: 'path must be absolute or use a working folder' })
  try {
    const result = await ipcClient.invoke(IPC.FS_LIST_DIR, {
      path,
      ignore: Array.isArray(input.ignore)
        ? input.ignore.filter((item): item is string => typeof item === 'string')
        : []
    })
    return encodeStructuredToolResult(
      result && typeof result === 'object'
        ? { entries: Array.isArray(result) ? result : result }
        : { result }
    )
  } catch (error) {
    return encodeStructuredToolResult({
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function readRaw(path: string): Promise<string | { error: string }> {
  try {
    const result = await ipcClient.invoke(IPC.FS_READ_FILE, { path, raw: true })
    if (typeof result === 'string') return result
    if (result && typeof result === 'object' && 'error' in result)
      return { error: String((result as { error?: unknown }).error ?? 'Failed to read file') }
    return { error: 'File is not a text file' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function writeFile(
  input: Record<string, unknown>,
  ctx: Parameters<ToolHandler['execute']>[1]
) {
  const path = resolveWorkspacePath(input.file_path, ctx.workingFolder)
  const content = typeof input.content === 'string' ? input.content : null
  if (!path || content === null)
    return encodeStructuredToolResult({ error: 'file_path and content are required' })
  const before = await readRaw(path)
  if (typeof before !== 'string' && !String(input.content).length)
    return encodeStructuredToolResult(before)
  try {
    const result = await ipcClient.invoke(IPC.FS_WRITE_FILE, {
      path,
      content,
      beforeContent: typeof before === 'string' ? before : undefined,
      changeMeta: {
        runId: ctx.agentRunId,
        sessionId: ctx.sessionId ?? undefined,
        toolUseId: ctx.currentToolUseId,
        toolName: 'Write'
      }
    })
    return encodeStructuredToolResult(
      result && typeof result === 'object' ? { ...(result as Record<string, unknown>) } : { result }
    )
  } catch (error) {
    return encodeStructuredToolResult({
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function editFile(
  input: Record<string, unknown>,
  ctx: Parameters<ToolHandler['execute']>[1]
) {
  const path = resolveWorkspacePath(input.file_path, ctx.workingFolder)
  const oldString = typeof input.old_string === 'string' ? input.old_string : ''
  const newString = typeof input.new_string === 'string' ? input.new_string : null
  if (!path || !oldString || newString === null)
    return encodeStructuredToolResult({
      error: 'file_path, old_string, and new_string are required'
    })
  const before = await readRaw(path)
  if (typeof before !== 'string') return encodeStructuredToolResult(before)
  const occurrences = before.split(oldString).length - 1
  if (occurrences === 0) return encodeStructuredToolResult({ error: 'old_string was not found' })
  if (occurrences > 1 && input.replace_all !== true)
    return encodeStructuredToolResult({ error: 'old_string is not unique; set replace_all=true' })
  const content =
    input.replace_all === true
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString)
  return writeFile({ file_path: path, content }, ctx)
}

async function editNotebook(
  input: Record<string, unknown>,
  ctx: Parameters<ToolHandler['execute']>[1]
) {
  const path = resolveWorkspacePath(input.notebook_path ?? input.file_path, ctx.workingFolder)
  if (!path) return encodeStructuredToolResult({ error: 'notebook_path is required' })
  const before = await readRaw(path)
  if (typeof before !== 'string') return encodeStructuredToolResult(before)
  let notebook: { cells: Array<Record<string, unknown>>; [key: string]: unknown }
  try {
    const parsed = JSON.parse(before) as unknown
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { cells?: unknown }).cells)
    )
      return encodeStructuredToolResult({ error: 'Invalid Jupyter notebook JSON' })
    notebook = parsed as { cells: Array<Record<string, unknown>>; [key: string]: unknown }
  } catch (error) {
    return encodeStructuredToolResult({ error: `Invalid Jupyter notebook JSON: ${String(error)}` })
  }
  const cells = notebook.cells
  const cellId = typeof input.cell_id === 'string' ? input.cell_id.trim() : ''
  const cellIndex = typeof input.cell_index === 'number' ? Math.trunc(input.cell_index) : -1
  const index = cellId ? cells.findIndex((cell) => cell.id === cellId) : cellIndex
  const mode = input.mode === 'insert' || input.mode === 'delete' ? input.mode : 'replace'
  if (mode !== 'insert' && (index < 0 || index >= cells.length))
    return encodeStructuredToolResult({ error: 'Notebook cell was not found' })
  if (mode === 'delete') {
    cells.splice(index, 1)
  } else {
    const sourceValue = input.new_source ?? input.source
    if (typeof sourceValue !== 'string')
      return encodeStructuredToolResult({ error: 'new_source is required for notebook edits' })
    const cellType =
      input.cell_type === 'markdown' || input.cell_type === 'raw' ? input.cell_type : 'code'
    const source = sourceValue.split(/(?<=\n)/)
    const nextCell = {
      cell_type: cellType,
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      metadata: {},
      source
    }
    if (mode === 'insert') cells.splice(Math.max(0, cellIndex), 0, nextCell)
    else cells[index] = { ...cells[index], cell_type: cellType, source }
  }
  return writeFile({ file_path: path, content: `${JSON.stringify(notebook, null, 2)}\n` }, ctx)
}

const readHandler: ToolHandler = {
  definition: {
    name: 'Read',
    description: 'Read a file from the filesystem',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        offset: { type: 'number', description: 'Start line (1-indexed)' },
        limit: { type: 'number', description: 'Number of lines to read' }
      },
      required: ['file_path']
    }
  },
  execute: readFile,
  requiresApproval: () => false,
  capability: {
    readOnly: true,
    sideEffectFree: true,
    parallelizable: true,
    riskLevel: 'low',
    requiresApproval: false,
    source: 'core',
    owner: 'filesystem',
    projectScoped: true
  }
}

const writeHandler: ToolHandler = {
  definition: {
    name: 'Write',
    description:
      "Writes a file to the filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        content: { type: 'string', description: 'The content to write to the file' }
      },
      required: ['file_path', 'content']
    }
  },
  execute: writeFile,
  requiresApproval: () => true
}

const editHandler: ToolHandler = {
  definition: {
    name: 'Edit',
    description:
      'Performs exact string replacements in files. \n\nUsage:\n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`. \n- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        old_string: {
          type: 'string',
          description: 'The text to replace'
        },
        new_string: {
          type: 'string',
          description: 'The text to replace it with (must be different from old_string)'
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurences of old_string (default false)'
        }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  execute: editFile,
  requiresApproval: () => true
}

const notebookEditHandler: ToolHandler = {
  definition: {
    name: 'NotebookEdit',
    description: 'Edit a Jupyter notebook cell by index or cell_id.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_path: {
          type: 'string',
          description: 'Notebook path, absolute or relative to the working folder'
        },
        file_path: {
          type: 'string',
          description: 'Alias for notebook_path'
        },
        cell_id: { type: 'string', description: 'Cell id to edit' },
        cell_index: { type: 'number', description: 'Zero-based cell index' },
        mode: {
          type: 'string',
          enum: ['replace', 'insert', 'delete'],
          description: 'Edit mode. Defaults to replace.'
        },
        new_source: { type: 'string', description: 'New cell source' },
        source: { type: 'string', description: 'Alias for new_source' },
        cell_type: {
          type: 'string',
          enum: ['code', 'markdown', 'raw'],
          description: 'Cell type for inserted or replaced cells'
        }
      },
      required: []
    }
  },
  execute: editNotebook,
  requiresApproval: () => true
}

const lsHandler: ToolHandler = {
  definition: {
    name: 'LS',
    description: 'List files and directories in a given path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or relative to the working folder' },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns to ignore'
        },
        hidden: {
          type: 'boolean',
          description: 'Include hidden files and directories. Defaults to true.'
        },
        respectGitignore: {
          type: 'boolean',
          description: 'Respect .gitignore files. Defaults to true.'
        }
      },
      required: []
    }
  },
  execute: listDirectory,
  requiresApproval: () => false,
  capability: {
    readOnly: true,
    sideEffectFree: true,
    parallelizable: true,
    riskLevel: 'low',
    requiresApproval: false,
    source: 'core',
    owner: 'filesystem',
    projectScoped: true
  }
}

export function registerFsTools(): void {
  toolRegistry.register(readHandler)
  toolRegistry.register(writeHandler)
  toolRegistry.register(editHandler)
  toolRegistry.register(notebookEditHandler)
  toolRegistry.register(lsHandler)
}
