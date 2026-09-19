import { BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { safeSendMessagePackToWindow } from '../window-ipc'
import { buildShellEnvironment } from './shell-environment'
import { registerMessagePackHandler } from './messagepack-handler'
import { TerminalSessionManager } from '../terminal/terminal-session-manager'

interface CreateTerminalSessionArgs {
  cwd?: string
  shell?: string
  cols?: number
  rows?: number
  title?: string
  command?: string
}

interface CreateTerminalSessionResult {
  id?: string
  shell?: string
  cwd?: string
  cols?: number
  rows?: number
  createdAt?: number
  title?: string
  command?: string
  error?: string
}

interface TerminalOutputChunk {
  seq: number
  data: string
}

interface TerminalOutputEvent {
  id: string
  data: string
  seq: number
}

interface TerminalExitEvent {
  id: string
  exitCode: number
  signal?: number
}

interface TerminalSessionListEntry {
  id: string
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  title: string
  command?: string
  exitCode?: number
  exitSignal?: number
  buffer?: TerminalOutputChunk[]
}

const terminalWindowIds = new Map<string, number | null>()
const terminalOutputListeners = new Set<(event: TerminalOutputEvent) => void>()
const terminalExitListeners = new Set<(event: TerminalExitEvent) => void>()
let terminalEventsRegistered = false
const terminalSessions = new TerminalSessionManager()

function resolveOwnerWindowId(sender?: WebContents | null): number | null {
  return sender ? (BrowserWindow.fromWebContents(sender)?.id ?? null) : null
}

function isTrustedTerminalIpcSender(event: IpcMainInvokeEvent): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  return (
    ownerWindow !== null &&
    !ownerWindow.isDestroyed() &&
    ownerWindow.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame
  )
}

function isTerminalOwnedBy(id: string, sender?: WebContents | null): boolean {
  const ownerWindowId = terminalWindowIds.get(id)
  return typeof ownerWindowId === 'number' && ownerWindowId === resolveOwnerWindowId(sender)
}

function createWindowEvent(windowId: number | null, channel: string, payload: unknown): void {
  const win =
    (typeof windowId === 'number'
      ? BrowserWindow.getAllWindows().find((candidate) => candidate.id === windowId)
      : null) ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  safeSendMessagePackToWindow(win, channel, payload)
}

function emitTerminalOutput(event: TerminalOutputEvent): void {
  terminalOutputListeners.forEach((listener) => listener(event))
}

function emitTerminalExit(event: TerminalExitEvent): void {
  terminalExitListeners.forEach((listener) => listener(event))
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

function ensureTerminalEventBridge(): void {
  if (terminalEventsRegistered) return
  terminalEventsRegistered = true
  terminalSessions.onOutput((params) => {
    createWindowEvent(terminalWindowIds.get(params.id) ?? null, 'terminal:output', params)
    emitTerminalOutput(params)
  })
  terminalSessions.onExit((params) => {
    createWindowEvent(terminalWindowIds.get(params.id) ?? null, 'terminal:exit', params)
    emitTerminalExit(params)
  })
}

function toCreatedEvent(result: CreateTerminalSessionResult): TerminalSessionListEntry | null {
  if (!result.id || !result.shell || !result.cwd || !result.createdAt || !result.title) {
    return null
  }

  return {
    id: result.id,
    shell: result.shell,
    cwd: result.cwd,
    cols: result.cols ?? 80,
    rows: result.rows ?? 24,
    createdAt: result.createdAt,
    title: result.title,
    ...(result.command ? { command: result.command } : {})
  }
}

export async function createTerminalSession(
  args: CreateTerminalSessionArgs,
  sender?: WebContents | null,
  extraEnvironment?: Record<string, string>
): Promise<CreateTerminalSessionResult> {
  ensureTerminalEventBridge()
  const ownerWindowId = resolveOwnerWindowId(sender)
  const result = (() => {
    try {
      return terminalSessions.create({
        cwd: args.cwd || process.cwd(),
        ...(args.shell ? { shell: args.shell } : {}),
        cols: Math.max(20, Math.floor(args.cols ?? 80)),
        rows: Math.max(5, Math.floor(args.rows ?? 24)),
        ...(args.title ? { title: args.title } : {}),
        ...(args.command ? { command: args.command } : {}),
        env: { ...serializeShellEnvironment(), ...extraEnvironment }
      })
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })()

  if ('id' in result && result.id) {
    terminalWindowIds.set(result.id, ownerWindowId)
    const created = toCreatedEvent(result)
    if (created) {
      createWindowEvent(ownerWindowId, 'terminal:created', created)
    }
  }

  return result
}

export function onTerminalSessionOutput(
  listener: (event: TerminalOutputEvent) => void
): () => void {
  terminalOutputListeners.add(listener)
  return () => terminalOutputListeners.delete(listener)
}

export function onTerminalSessionExit(listener: (event: TerminalExitEvent) => void): () => void {
  terminalExitListeners.add(listener)
  return () => terminalExitListeners.delete(listener)
}

export function registerTerminalHandlers(): void {
  ensureTerminalEventBridge()

  registerMessagePackHandler<CreateTerminalSessionArgs>('terminal:create', async (args, event) => {
    if (!isTrustedTerminalIpcSender(event)) return { error: 'Unauthorized terminal IPC sender' }
    return await createTerminalSession(args, event.sender)
  })

  registerMessagePackHandler<{ id: string; data: string }>(
    'terminal:input',
    async (args, event) => {
      if (!isTerminalOwnedBy(args.id, event.sender)) return { error: 'Terminal not found' }
      return await writeTerminalSession(args.id, args.data)
    }
  )

  registerMessagePackHandler<{ id: string; cols: number; rows: number }>(
    'terminal:resize',
    async (args, event) => {
      if (!isTerminalOwnedBy(args.id, event.sender)) return { error: 'Terminal not found' }
      const result = terminalSessions.resize(args.id, args.cols, args.rows)
      return result.success
        ? { success: true }
        : { error: result.error ?? 'Terminal resize failed' }
    }
  )

  registerMessagePackHandler<{ id: string }>('terminal:kill', async (args, event) => {
    if (!isTerminalOwnedBy(args.id, event.sender)) return { error: 'Terminal not found' }
    return await killTerminalSession(args.id)
  })

  registerMessagePackHandler<{ id: string }>('terminal:get', async (args, event) => {
    if (!isTerminalOwnedBy(args.id, event.sender)) {
      return { success: false, error: 'Terminal not found' }
    }
    const session = await getTerminalSessionSnapshot(args.id)
    return session ? { success: true, session } : { success: false, error: 'Terminal not found' }
  })

  registerMessagePackHandler<undefined>('terminal:list', async (_args, event) => {
    ensureTerminalEventBridge()
    const ownerWindowId = resolveOwnerWindowId(event.sender)
    const sessions = terminalSessions.list()
    return sessions.filter((session) => terminalWindowIds.get(session.id) === ownerWindowId)
  })
}

export async function getTerminalSessionSnapshot(
  id: string
): Promise<TerminalSessionListEntry | undefined> {
  ensureTerminalEventBridge()
  return terminalSessions.get(id)
}

export async function writeTerminalSession(
  id: string,
  data: string
): Promise<{ success?: true; error?: string }> {
  ensureTerminalEventBridge()
  const result = terminalSessions.input(id, data)
  return result.success ? { success: true } : { error: result.error ?? 'Terminal input failed' }
}

export async function killTerminalSession(id: string): Promise<{ success?: true; error?: string }> {
  ensureTerminalEventBridge()
  const result = terminalSessions.kill(id)
  if (result.success) {
    terminalWindowIds.delete(id)
    return { success: true }
  }
  return { error: result.error ?? 'Terminal kill failed' }
}

export function killAllTerminalSessions(): void {
  if (!terminalEventsRegistered) return
  terminalWindowIds.clear()
  terminalSessions.killAll()
}
