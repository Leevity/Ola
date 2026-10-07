import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'
import {
  execSshCommand,
  globSshRuntimeFiles,
  grepSshRuntimeFiles,
  listSshRuntimeDirectory,
  readSshRuntimeFile,
  readSshRuntimeText,
  statSshRuntimePath,
  writeSshRuntimeFile
} from '../ipc/ssh-handlers'
import { withSshWorkspace } from '../ssh/ssh-config'
import { authorizeSshWorkspace } from '../ssh/ssh-workspace-authorization'
import { loadOfflineWorkspaceIds } from '../remote/account-client'

const MAX_COMMAND_BYTES = 16 * 1024
const MAX_TEXT_BYTES = 128 * 1024
const MAX_TIMEOUT_MS = 120_000

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function pathInput(value: unknown, required = true): string {
  const item = record(value)
  const candidate = item.file_path ?? item.path
  if (candidate === undefined && !required) return '.'
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 4096)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return candidate.trim()
}

function shellInput(value: unknown): { command: string; timeoutMs: number; outputFiles: string[] } {
  const item = record(value)
  const command = item.command
  const timeoutMs = item.timeoutMs
  if (Object.keys(item).some((key) => !['command', 'timeoutMs', 'outputFiles'].includes(key)))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    Buffer.byteLength(command) > MAX_COMMAND_BYTES
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const outputFiles = item.outputFiles ?? []
  if (
    !Array.isArray(outputFiles) ||
    outputFiles.length > 16 ||
    outputFiles.some(
      (path) =>
        typeof path !== 'string' ||
        !path.startsWith('/') ||
        path.length > 4096 ||
        path.includes('\0') ||
        path.split('/').includes('..')
    )
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return {
    command,
    timeoutMs: timeoutMs === undefined ? 30_000 : timeoutMs,
    outputFiles: [...new Set(outputFiles)]
  }
}

type RemoteFileSnapshot = {
  exists?: boolean
  type?: string | null
  size?: number | null
  mtimeMs?: number | null
  error?: string
}

async function workspaceCall<T>(
  connectionId: string,
  context: Parameters<ToolDefinition['execute']>[1],
  operation: () => Promise<T>
): Promise<T> {
  void connectionId
  const workspaceId = await authorizeSshWorkspace(context.run.workspaceId, loadOfflineWorkspaceIds)
  context.signal.throwIfAborted()
  const result = await withSshWorkspace(workspaceId, operation)
  context.signal.throwIfAborted()
  return result
}

function resource(
  connectionId: string,
  context: Parameters<ToolDefinition['resources']>[1]
): string {
  return `ssh:${context.run.workspaceId}:${connectionId}`
}

function fileTool(
  connectionId: string,
  name: 'Read' | 'Write' | 'Edit',
  scenarioRoot?: string
): ToolDefinition {
  const write = name !== 'Read'
  return {
    name,
    description:
      name === 'Read'
        ? 'Read a text file from the selected SSH host.'
        : name === 'Write'
          ? 'Write a text file on the selected SSH host.'
          : 'Apply an exact text replacement on the selected SSH host.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
        content: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required:
        name === 'Read'
          ? ['file_path']
          : name === 'Write'
            ? ['file_path', 'content']
            : ['file_path', 'old_string', 'new_string'],
      additionalProperties: false
    },
    effect: write ? 'write' : 'read',
    validate: (value) => {
      const item = record(value)
      const filePath = pathInput(item)
      if (name === 'Read') {
        return {
          file_path: filePath,
          offset: typeof item.offset === 'number' ? Math.max(1, Math.trunc(item.offset)) : 1,
          limit: typeof item.limit === 'number' ? Math.max(1, Math.trunc(item.limit)) : 2000
        }
      }
      if (name === 'Write') {
        if (typeof item.content !== 'string' || Buffer.byteLength(item.content) > MAX_TEXT_BYTES)
          throw new RuntimeError('INVALID_TOOL_INPUT')
        return { file_path: filePath, content: item.content }
      }
      if (
        typeof item.old_string !== 'string' ||
        !item.old_string ||
        typeof item.new_string !== 'string' ||
        item.old_string === item.new_string
      )
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return {
        file_path: filePath,
        old_string: item.old_string,
        new_string: item.new_string,
        replace_all: item.replace_all === true
      }
    },
    resources: async (_value, context) => [resource(connectionId, context)],
    artifacts: async (output, context) => {
      if (!write) return []
      const result = record(output)
      if (result.success !== true || typeof result.path !== 'string' || !result.path.trim())
        return []
      context.signal.throwIfAborted()
      const stat = (await statSshRuntimePath(
        context.run.workspaceId,
        connectionId,
        result.path
      )) as { exists?: boolean; type?: string | null; error?: string }
      context.signal.throwIfAborted()
      if (!stat.exists || stat.type !== 'file') return []
      return [
        {
          kind: 'file',
          transport: 'ssh',
          connectionId,
          path: result.path,
          operation: name === 'Write' ? 'create' : 'modify'
        }
      ]
    },
    execute: async (value, context) => {
      const item = value as Record<string, unknown>
      const filePath = item.file_path as string
      if (name === 'Read')
        return await workspaceCall(connectionId, context, () =>
          readSshRuntimeFile(
            connectionId,
            filePath,
            item.offset as number,
            item.limit as number,
            scenarioRoot
          )
        )
      if (name === 'Write') {
        await workspaceCall(connectionId, context, () =>
          writeSshRuntimeFile(connectionId, filePath, item.content as string)
        )
        return { success: true, path: filePath }
      }
      const before = await workspaceCall(connectionId, context, () =>
        readSshRuntimeText(connectionId, filePath)
      )
      const oldString = item.old_string as string
      const occurrences = before.split(oldString).length - 1
      if (!occurrences) throw new RuntimeError('EDIT_STRING_NOT_FOUND')
      if (occurrences > 1 && item.replace_all !== true)
        throw new RuntimeError('EDIT_STRING_AMBIGUOUS')
      const content =
        item.replace_all === true
          ? before.split(oldString).join(item.new_string as string)
          : before.replace(oldString, item.new_string as string)
      await workspaceCall(connectionId, context, () =>
        writeSshRuntimeFile(connectionId, filePath, content)
      )
      return { success: true, path: filePath }
    }
  }
}

/** Main-owned SSH filesystem and shell tools. Credentials stay inside Main. */
export function createSshRuntimeTools(
  connectionId: string,
  scenarioRoot?: string
): ToolDefinition[] {
  const shell: ToolDefinition = {
    name: 'Bash',
    description:
      'Run an approved shell command on the selected SSH host. Declare absolute outputFiles expected to be created or modified; only confirmed changes after a successful command become results.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS },
        outputFiles: { type: 'array', items: { type: 'string' }, maxItems: 16 }
      },
      required: ['command'],
      additionalProperties: false
    },
    effect: 'write',
    validate: shellInput,
    resources: async (_value, context) => [resource(connectionId, context)],
    artifacts: async (output, context) => {
      const result = record(output)
      if (result.exitCode !== 0 || result.timedOut !== false || !Array.isArray(result.artifacts))
        return []
      const artifacts: Awaited<ReturnType<NonNullable<ToolDefinition['artifacts']>>> = []
      for (const entry of result.artifacts.slice(0, 16)) {
        const candidate = record(entry)
        if (
          typeof candidate.path !== 'string' ||
          !['create', 'modify'].includes(candidate.operation as string)
        )
          continue
        context.signal.throwIfAborted()
        const stat = (await statSshRuntimePath(
          context.run.workspaceId,
          connectionId,
          candidate.path
        )) as RemoteFileSnapshot
        context.signal.throwIfAborted()
        if (stat.exists === true && stat.type === 'file')
          artifacts.push({
            kind: 'file',
            transport: 'ssh',
            connectionId,
            path: candidate.path,
            operation: candidate.operation as 'create' | 'modify'
          })
      }
      return artifacts
    },
    execute: async (value, context) => {
      const request = value as ReturnType<typeof shellInput>
      const before = new Map<string, RemoteFileSnapshot>()
      for (const path of request.outputFiles ?? []) {
        context.signal.throwIfAborted()
        const stat = (await statSshRuntimePath(
          context.run.workspaceId,
          connectionId,
          path
        )) as RemoteFileSnapshot
        if (stat.error) throw new RuntimeError('SSH_STAT_FAILED')
        before.set(path, stat)
      }
      const result = await workspaceCall(connectionId, context, () =>
        execSshCommand(connectionId, request.command, request.timeoutMs)
      )
      if (!result.success && result.error) throw new RuntimeError('SSH_EXEC_FAILED')
      const artifacts: Array<{ path: string; operation: 'create' | 'modify' }> = []
      if (result.success && result.exitCode === 0 && result.timing?.timedOut !== true) {
        for (const [path, previous] of before) {
          context.signal.throwIfAborted()
          const after = (await statSshRuntimePath(
            context.run.workspaceId,
            connectionId,
            path
          )) as RemoteFileSnapshot
          if (after.exists !== true || after.type !== 'file' || after.error) continue
          // SFTP timestamps may be coarse. If a change cannot be confirmed, omit the result.
          if (
            previous.exists === false ||
            (previous.type === 'file' &&
              (previous.size !== after.size || previous.mtimeMs !== after.mtimeMs))
          )
            artifacts.push({ path, operation: previous.exists ? 'modify' : 'create' })
        }
      }
      context.signal.throwIfAborted()
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timing?.timedOut === true,
        ...(before.size ? { artifacts } : {})
      }
    }
  }
  const ls: ToolDefinition = {
    name: 'LS',
    description: 'List a directory on the selected SSH host.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    effect: 'read',
    validate: (value) => ({ path: pathInput(value, false) }),
    resources: async (_value, context) => [resource(connectionId, context)],
    execute: async (value, context) =>
      await workspaceCall(connectionId, context, () =>
        listSshRuntimeDirectory(connectionId, (value as { path: string }).path, scenarioRoot)
      )
  }
  const glob: ToolDefinition = {
    name: 'Glob',
    description: 'Find matching paths on the selected SSH host.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern']
    },
    effect: 'read',
    validate: (value) => {
      const item = record(value)
      if (typeof item.pattern !== 'string' || !item.pattern.trim())
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return { pattern: item.pattern, path: pathInput(item, false) }
    },
    resources: async (_value, context) => [resource(connectionId, context)],
    execute: async (value, context) =>
      await workspaceCall(connectionId, context, () =>
        globSshRuntimeFiles(
          connectionId,
          (value as { pattern: string }).pattern,
          (value as { path: string }).path,
          scenarioRoot
        )
      )
  }
  const grep: ToolDefinition = {
    name: 'Grep',
    description: 'Search text on the selected SSH host.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern']
    },
    effect: 'read',
    validate: (value) => {
      const item = record(value)
      if (typeof item.pattern !== 'string' || !item.pattern.trim())
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return { ...item, pattern: item.pattern, path: pathInput(item, false) }
    },
    resources: async (_value, context) => [resource(connectionId, context)],
    execute: async (value, context) =>
      await workspaceCall(connectionId, context, () =>
        grepSshRuntimeFiles(connectionId, value as Record<string, unknown>, scenarioRoot)
      )
  }
  return [
    fileTool(connectionId, 'Read', scenarioRoot),
    ls,
    glob,
    grep,
    fileTool(connectionId, 'Write'),
    fileTool(connectionId, 'Edit'),
    shell
  ]
}
