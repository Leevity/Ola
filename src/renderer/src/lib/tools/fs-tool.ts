import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'
import {
  WORKSPACE_PROTOCOL_TOOLS,
  workspaceToolDefinition
} from '../../../../shared/tool-catalog/workspace-protocol'

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
  const path = resolveWorkspacePath(input.file_path ?? input.path, ctx.workingFolder)
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
  const path = resolveWorkspacePath(input.file_path ?? input.path, ctx.workingFolder)
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
  const path = resolveWorkspacePath(input.file_path ?? input.path, ctx.workingFolder)
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
  definition: workspaceToolDefinition(WORKSPACE_PROTOCOL_TOOLS.Read),
  execute: readFile,
  requiresApproval: () => WORKSPACE_PROTOCOL_TOOLS.Read.requiresApproval,
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
  definition: workspaceToolDefinition(WORKSPACE_PROTOCOL_TOOLS.Write),
  execute: writeFile,
  requiresApproval: () => WORKSPACE_PROTOCOL_TOOLS.Write.requiresApproval
}

const editHandler: ToolHandler = {
  definition: workspaceToolDefinition(WORKSPACE_PROTOCOL_TOOLS.Edit),
  execute: editFile,
  requiresApproval: () => WORKSPACE_PROTOCOL_TOOLS.Edit.requiresApproval
}

const notebookEditHandler: ToolHandler = {
  definition: workspaceToolDefinition(WORKSPACE_PROTOCOL_TOOLS.NotebookEdit),
  execute: editNotebook,
  requiresApproval: () => WORKSPACE_PROTOCOL_TOOLS.NotebookEdit.requiresApproval
}

const lsHandler: ToolHandler = {
  definition: workspaceToolDefinition(WORKSPACE_PROTOCOL_TOOLS.LS),
  execute: listDirectory,
  requiresApproval: () => WORKSPACE_PROTOCOL_TOOLS.LS.requiresApproval,
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
