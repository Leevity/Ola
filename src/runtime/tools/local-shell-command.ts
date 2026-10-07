import { RuntimeError } from '../../shared/runtime/contracts'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { executeLocalShell } from '../host/local-shell-executor'
import type { WorkspaceRootResolver } from './local-read-file'
import type { ToolDefinition } from './tool-executor'

type ShellInput = { command: string; timeoutMs: number; outputFiles: string[] }
const MAX_COMMAND_BYTES = 16 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_FILES = 16

export interface LocalShellCommandOptions {
  shell?: string
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
}

type FileSnapshot = {
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  dev: bigint
  ino: bigint
}

function insideRoot(root: string, target: string): boolean {
  const part = relative(root, target)
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

async function fileSnapshot(path: string): Promise<FileSnapshot | null> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (!stat.isFile()) return null
    return {
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      dev: stat.dev,
      ino: stat.ino
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

function changed(before: FileSnapshot | null, after: FileSnapshot): boolean {
  return (
    !before ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  )
}

function input(value: unknown, defaultTimeoutMs: number, maxTimeoutMs: number): ShellInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => !['command', 'timeoutMs', 'outputFiles'].includes(key)))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const command = item.command
  const timeoutValue = item.timeoutMs
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    Buffer.byteLength(command) > MAX_COMMAND_BYTES
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (
    timeoutValue !== undefined &&
    (typeof timeoutValue !== 'number' ||
      !Number.isSafeInteger(timeoutValue) ||
      timeoutValue < 1 ||
      timeoutValue > maxTimeoutMs)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const outputFiles = item.outputFiles ?? []
  if (
    !Array.isArray(outputFiles) ||
    outputFiles.length > MAX_OUTPUT_FILES ||
    outputFiles.some(
      (path) =>
        typeof path !== 'string' || !path.trim() || path.length > 4096 || path.includes('\0')
    )
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return {
    command,
    timeoutMs: timeoutValue === undefined ? defaultTimeoutMs : timeoutValue,
    outputFiles
  }
}

/** Runs an approved shell command only inside Main-approved workspace root. */
export function createLocalShellCommandTool(
  workspaceRoot: string | WorkspaceRootResolver,
  options: LocalShellCommandOptions = {}
): ToolDefinition {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTimeoutMs = options.maxTimeoutMs ?? MAX_TIMEOUT_MS
  if (
    !Number.isSafeInteger(defaultTimeoutMs) ||
    !Number.isSafeInteger(maxTimeoutMs) ||
    defaultTimeoutMs < 1 ||
    defaultTimeoutMs > maxTimeoutMs ||
    maxTimeoutMs > 3_600_000
  )
    throw new RuntimeError('INVALID_TOOL_CONFIGURATION')
  const root = async (context: Parameters<ToolDefinition['execute']>[1]): Promise<string> =>
    typeof workspaceRoot === 'string' ? workspaceRoot : await workspaceRoot(context)
  return {
    name: 'run_shell_command',
    description:
      'Run an approved shell command in the configured workspace. Declare outputFiles only for files this command is expected to create or modify; they are verified after a successful exit.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: maxTimeoutMs },
        outputFiles: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_OUTPUT_FILES,
          description: 'Workspace file paths expected to be created or modified by this command.'
        }
      },
      required: ['command'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => input(value, defaultTimeoutMs, maxTimeoutMs),
    resources: async (_value, context) => [await realpath(await root(context))],
    execute: async (value, context) => {
      const request = value as ShellInput
      const workspace = await realpath(await root(context))
      const declared = [
        ...new Set((request.outputFiles ?? []).map((path) => resolve(workspace, path)))
      ]
      if (declared.some((path) => !insideRoot(workspace, path)))
        throw new RuntimeError('TOOL_PATH_FORBIDDEN')
      const before = new Map<string, FileSnapshot | null>()
      for (const path of declared) {
        const snapshot = await fileSnapshot(path)
        if (snapshot === null) {
          const metadata = await lstat(path).catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
            throw error
          })
          if (metadata) throw new RuntimeError('TOOL_ARTIFACT_PATH_INVALID')
        }
        before.set(path, snapshot)
      }
      const result = await executeLocalShell({
        command: request.command,
        cwd: workspace,
        timeoutMs: request.timeoutMs,
        ...(options.shell ? { shell: options.shell } : {}),
        env: {},
        maxOutputBytes: MAX_OUTPUT_BYTES,
        signal: context.signal
      })
      context.signal.throwIfAborted()
      if (result.outputLimitExceeded) throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
      const artifacts: Array<{ path: string; operation: 'create' | 'modify' }> = []
      const registered = new Set<string>()
      if (result.exitCode === 0 && !result.timedOut && !result.aborted) {
        for (const path of declared) {
          const after = await fileSnapshot(path)
          if (!after || !changed(before.get(path) ?? null, after)) continue
          const canonical = await realpath(path).catch(() => null)
          if (!canonical || !insideRoot(workspace, canonical) || registered.has(canonical)) continue
          registered.add(canonical)
          artifacts.push({ path: canonical, operation: before.get(path) ? 'modify' : 'create' })
        }
      }
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        artifacts
      }
    }
  }
}
