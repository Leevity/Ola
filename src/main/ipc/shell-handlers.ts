import {
  ipcMain,
  shell,
  BrowserWindow,
  app,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { safeSendMessagePackToWindow } from '../window-ipc'
import { executeLocalShell } from '../shell/local-shell-executor'
import { buildShellEnvironment } from './shell-environment'
import { decodeMessagePackPayload, toMessagePackChannel } from '../../shared/messagepack/binary-ipc'
import { registerMessagePackHandler } from './messagepack-handler'

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const COMPACT_OUTPUT_CHAR_THRESHOLD = 6000
const COMPACT_OUTPUT_LINE_THRESHOLD = 160
const MAX_RETURNED_STDOUT_CHARS = 12000
const MAX_RETURNED_STDERR_CHARS = 8000
const HEAD_LINE_COUNT = 8
const TAIL_LINE_COUNT = 60
const MAX_ERROR_LINE_COUNT = 30
const MAX_WARNING_LINE_COUNT = 20
const ERROR_LIKE_RE =
  /\b(error|failed|exception|traceback|fatal|panic|cannot|unable|undefined reference|syntax error|test(?:s)? failed?)\b/i
const WARNING_LIKE_RE = /\bwarn(?:ing)?\b/i

type ShellStream = 'stdout' | 'stderr'

interface ShellOutputSummary {
  mode: 'full' | 'compact'
  noisy: boolean
  totalChars: number
  totalLines: number
  stdoutLines: number
  stderrLines: number
  errorLikeLines: number
  warningLikeLines: number
  totalMs?: number
  spawnMs?: number
  firstChunkMs?: number
  shell?: string
  outputFile?: string
  executionEngine?: 'main' | 'native_aot'
  timedOut?: boolean
  aborted?: boolean
}

interface CompactStreamResult {
  text: string
  totalChars: number
  totalLines: number
  errorLikeLines: number
  warningLikeLines: number
  compacted: boolean
}

interface ShellExecutionTiming {
  totalMs: number
  spawnMs: number
  firstChunkMs?: number
  shell: string
  executionEngine?: 'main' | 'native_aot'
  timedOut?: boolean
  aborted?: boolean
}

interface ShellStartedEvent {
  execId: string
  processId: string
  terminalId: string
}

const UNAUTHORIZED_SHELL_IPC_ERROR = 'Unauthorized shell IPC sender'

function getTrustedShellOwnerWindow(
  event: IpcMainInvokeEvent | IpcMainEvent
): BrowserWindow | null {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  return ownerWindow !== null &&
    !ownerWindow.isDestroyed() &&
    ownerWindow.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame
    ? ownerWindow
    : null
}

function isTrustedShellIpcSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return getTrustedShellOwnerWindow(event) !== null
}

function registerTrustedShellMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs, event: IpcMainInvokeEvent) => Promise<unknown> | unknown
): void {
  registerMessagePackHandler<TArgs>(channel, async (args, event) => {
    if (!isTrustedShellIpcSender(event)) {
      return { error: UNAUTHORIZED_SHELL_IPC_ERROR }
    }
    return await handler(args, event)
  })
}

type OpenWithAppId = 'vscode'

type ShellExecArgs = {
  command: string
  timeout?: number
  cwd?: string
  execId?: string
  shell?: string
}

interface OpenCommand {
  command: string
  args: string[]
}

function stripAnsi(raw: string): string {
  return raw.replace(ANSI_ESCAPE_RE, '')
}

function sanitizeOutput(raw: string, maxLen: number): string {
  const normalized = stripAnsi(raw)
  const trimmed = normalized.slice(0, maxLen)
  const sample = trimmed.slice(0, 256)
  let bad = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffd) bad++
  }
  if (sample.length > 0 && bad / sample.length > 0.1) {
    return `[Binary or non-text output, ${raw.length} bytes - content omitted]`
  }
  return trimmed
}

function splitLines(raw: string): string[] {
  const normalized = stripAnsi(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return normalized.split('\n')
}

function collectMatchingLines(lines: string[], pattern: RegExp, limit: number): string[] {
  const seen = new Set<string>()
  const matches: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || !pattern.test(line)) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    matches.unshift(line)
    if (matches.length >= limit) break
  }
  return matches
}

function compactStreamOutput(
  raw: string,
  stream: ShellStream,
  exitCode: number,
  maxLen: number
): CompactStreamResult {
  const sanitized = sanitizeOutput(raw, maxLen)
  const lines = splitLines(raw)
  const errorLines = collectMatchingLines(lines, ERROR_LIKE_RE, MAX_ERROR_LINE_COUNT)
  const warningLines = collectMatchingLines(lines, WARNING_LIKE_RE, MAX_WARNING_LINE_COUNT)
  const noisy =
    stripAnsi(raw).length > COMPACT_OUTPUT_CHAR_THRESHOLD ||
    lines.length > COMPACT_OUTPUT_LINE_THRESHOLD

  if (!noisy) {
    return {
      text: sanitized,
      totalChars: stripAnsi(raw).length,
      totalLines: lines.length,
      errorLikeLines: errorLines.length,
      warningLikeLines: warningLines.length,
      compacted: false
    }
  }

  const head = lines.slice(0, HEAD_LINE_COUNT)
  const tail = lines.slice(-TAIL_LINE_COUNT)
  const sections: string[] = []

  if (head.length > 0) {
    sections.push(head.join('\n'))
  }

  if (errorLines.length > 0 && (stream === 'stderr' || exitCode !== 0)) {
    sections.push(`[error-like lines]\n${errorLines.join('\n')}`)
  } else if (stream === 'stdout' && exitCode === 0 && warningLines.length > 0) {
    sections.push(`[warning-like lines]\n${warningLines.join('\n')}`)
  }

  const omittedLineCount = Math.max(lines.length - head.length - tail.length, 0)
  if (tail.length > 0) {
    const header =
      omittedLineCount > 0
        ? `[last ${tail.length} lines, omitted ${omittedLineCount} earlier lines]`
        : `[last ${tail.length} lines]`
    sections.push(`${header}\n${tail.join('\n')}`)
  }

  return {
    text: sanitizeOutput(sections.join('\n\n'), maxLen),
    totalChars: stripAnsi(raw).length,
    totalLines: lines.length,
    errorLikeLines: errorLines.length,
    warningLikeLines: warningLines.length,
    compacted: true
  }
}

function buildShellResult(payload: {
  exitCode: number
  stdout: string
  stderr: string
  error?: string
  processId?: string
  terminalId?: string
  timing?: ShellExecutionTiming
}): {
  exitCode: number
  stdout: string
  stderr: string
  error?: string
  processId?: string
  terminalId?: string
  outputFile?: string
  summary: ShellOutputSummary
} {
  const stdout = compactStreamOutput(
    payload.stdout,
    'stdout',
    payload.exitCode,
    MAX_RETURNED_STDOUT_CHARS
  )
  const stderr = compactStreamOutput(
    payload.stderr,
    'stderr',
    payload.exitCode,
    MAX_RETURNED_STDERR_CHARS
  )
  const outputFile =
    stdout.compacted || stderr.compacted
      ? writeShellOutputArchive(payload.stdout, payload.stderr)
      : undefined

  return {
    exitCode: payload.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.processId ? { processId: payload.processId } : {}),
    ...(payload.terminalId ? { terminalId: payload.terminalId } : {}),
    ...(outputFile ? { outputFile } : {}),
    summary: {
      mode: stdout.compacted || stderr.compacted ? 'compact' : 'full',
      noisy: stdout.compacted || stderr.compacted,
      totalChars: stdout.totalChars + stderr.totalChars,
      totalLines: stdout.totalLines + stderr.totalLines,
      stdoutLines: stdout.totalLines,
      stderrLines: stderr.totalLines,
      errorLikeLines: stdout.errorLikeLines + stderr.errorLikeLines,
      warningLikeLines: stdout.warningLikeLines + stderr.warningLikeLines,
      ...(outputFile ? { outputFile } : {}),
      ...(payload.timing
        ? {
            totalMs: payload.timing.totalMs,
            spawnMs: payload.timing.spawnMs,
            ...(payload.timing.firstChunkMs !== undefined
              ? { firstChunkMs: payload.timing.firstChunkMs }
              : {}),
            shell: payload.timing.shell,
            executionEngine: payload.timing.executionEngine ?? 'main',
            timedOut: payload.timing.timedOut === true,
            aborted: payload.timing.aborted === true
          }
        : {})
    }
  }
}

function writeShellOutputArchive(stdout: string, stderr: string): string | undefined {
  try {
    const outputDir = path.join(app.getPath('userData'), 'shell-output')
    fs.mkdirSync(outputDir, { recursive: true })
    const filePath = path.join(outputDir, `shell-output-${Date.now()}.txt`)
    const sections = [
      stdout ? `# stdout\n${stripAnsi(stdout)}` : '',
      stderr ? `# stderr\n${stripAnsi(stderr)}` : ''
    ].filter(Boolean)
    fs.writeFileSync(filePath, `${sections.join('\n\n')}\n`, 'utf-8')
    return filePath
  } catch {
    return undefined
  }
}

function runOpenCommand({ command, args }: OpenCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: false,
      stdio: 'ignore',
      windowsHide: true
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

function getOpenWithCommands(appId: OpenWithAppId, targetPath: string): OpenCommand[] {
  if (appId !== 'vscode') return []

  if (process.platform === 'darwin') {
    return [
      { command: '/usr/bin/open', args: ['-a', 'Visual Studio Code', targetPath] },
      { command: 'code', args: [targetPath] }
    ]
  }

  if (process.platform === 'win32') {
    return [{ command: 'cmd.exe', args: ['/d', '/s', '/c', 'code', targetPath] }]
  }

  return [{ command: 'code', args: [targetPath] }]
}

async function openWithWhitelistedApp(appId: OpenWithAppId, targetPath: string): Promise<void> {
  const commands = getOpenWithCommands(appId, targetPath)
  if (commands.length === 0) throw new Error(`Unsupported application: ${appId}`)

  let lastError: unknown
  for (const command of commands) {
    try {
      await runOpenCommand(command)
      return
    } catch (err) {
      lastError = err
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to open ${targetPath}`)
}

function serializeShellEnvironment(): Record<string, string> {
  const env = buildShellEnvironment()
  const serialized: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      serialized[key] = value
    }
  }
  return serialized
}

export function registerShellHandlers(): void {
  const runningShellProcesses = new Map<
    string,
    { ownerWindowId: number; terminalId: string; abort: (reason?: 'user' | 'timeout') => void }
  >()

  registerTrustedShellMessagePackHandler<ShellExecArgs>('shell:exec', async (args, event) => {
    const DEFAULT_TIMEOUT = 600_000
    const MAX_TIMEOUT = 3_600_000
    const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
    const execId = args.execId?.trim()
    if (execId && runningShellProcesses.has(execId)) {
      return { error: 'Shell execution ID is already active' }
    }
    const startedAt = Date.now()
    const ownerWindow = getTrustedShellOwnerWindow(event)
    if (!ownerWindow) return { error: UNAUTHORIZED_SHELL_IPC_ERROR }

    try {
      const result = await executeLocalShell({
        command: args.command,
        cwd: args.cwd || process.cwd(),
        timeoutMs: timeout,
        ...(args.shell ? { shell: args.shell } : {}),
        env: serializeShellEnvironment(),
        onOutput: (chunk, stream) => {
          if (execId)
            safeSendMessagePackToWindow(ownerWindow, 'shell:output', { execId, chunk, stream })
        },
        onStarted: (processId) => {
          if (!execId) return
          const payload: ShellStartedEvent = {
            execId,
            processId: processId || execId,
            terminalId: processId || execId
          }
          safeSendMessagePackToWindow(ownerWindow, 'shell:started', payload)
        },
        registerAbort: (abort) => {
          if (execId)
            runningShellProcesses.set(execId, {
              ownerWindowId: ownerWindow.id,
              terminalId: execId,
              abort
            })
        }
      })

      return buildShellResult({
        exitCode: result.exitCode,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timing: {
          totalMs: Date.now() - startedAt,
          spawnMs: 0,
          shell: result.shell,
          executionEngine: 'main',
          timedOut: result.timedOut,
          aborted: result.aborted
        }
      })
    } catch (err) {
      return buildShellResult({
        exitCode: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        error: err instanceof Error ? err.message : String(err),
        timing: {
          totalMs: Date.now() - startedAt,
          spawnMs: 0,
          shell: 'native',
          executionEngine: 'native_aot'
        }
      })
    } finally {
      if (execId) runningShellProcesses.delete(execId)
    }
  })

  const abortShellProcess = (data: { execId?: string }, event: IpcMainEvent): void => {
    const execId = data?.execId?.trim()
    const ownerWindow = getTrustedShellOwnerWindow(event)
    if (!execId || !ownerWindow) return
    const running = runningShellProcesses.get(execId)
    if (!running || running.ownerWindowId !== ownerWindow.id) return
    running.abort('user')
  }

  ipcMain.on(toMessagePackChannel('shell:abort'), (event, bytes: Uint8Array) => {
    if (!isTrustedShellIpcSender(event)) return
    abortShellProcess(decodeMessagePackPayload<{ execId?: string }>(bytes), event)
  })

  registerTrustedShellMessagePackHandler<string>('shell:openPath', async (folderPath) => {
    return shell.openPath(folderPath)
  })

  registerTrustedShellMessagePackHandler<string>('shell:showItemInFolder', async (targetPath) => {
    try {
      const resolvedPath = path.resolve(targetPath)
      if (!fs.existsSync(resolvedPath)) {
        return { error: `Path does not exist: ${resolvedPath}` }
      }

      shell.showItemInFolder(resolvedPath)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerTrustedShellMessagePackHandler<string>('shell:trashPath', async (targetPath) => {
    try {
      const resolvedPath = path.resolve(targetPath)
      if (!fs.existsSync(resolvedPath)) {
        return { error: `Path does not exist: ${resolvedPath}` }
      }

      await shell.trashItem(resolvedPath)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerTrustedShellMessagePackHandler<{ path: string; appId: OpenWithAppId }>(
    'shell:openWithApp',
    async (args) => {
      try {
        const resolvedPath = path.resolve(args.path)
        if (!fs.existsSync(resolvedPath)) {
          return { error: `Path does not exist: ${resolvedPath}` }
        }

        await openWithWhitelistedApp(args.appId, resolvedPath)
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerTrustedShellMessagePackHandler<string>('shell:openExternal', async (url) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      return shell.openExternal(url)
    }
  })
}
