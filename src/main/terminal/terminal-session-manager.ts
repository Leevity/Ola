import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as pty from 'node-pty'
import { olaExternalDataHome } from '../lib/ola-data-root'

const MAX_BUFFER_BYTES = 64 * 1024
const RETENTION_MS = 120_000

export type TerminalSessionRecord = {
  id: string
  workspaceId: string
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  title: string
  command?: string
  exitCode?: number
  exitSignal?: number
  buffer: Array<{ seq: number; data: string }>
}

type Session = TerminalSessionRecord & { pty: pty.IPty; bufferBytes: number; exitedAt?: number }

export class TerminalSessionManager {
  private sessions = new Map<string, Session>()
  private outputListeners = new Set<(event: { id: string; data: string; seq: number }) => void>()
  private exitListeners = new Set<
    (event: { id: string; exitCode: number; signal?: number }) => void
  >()

  onOutput(listener: (event: { id: string; data: string; seq: number }) => void): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  onExit(listener: (event: { id: string; exitCode: number; signal?: number }) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  create(input: {
    workspaceId?: string
    cwd?: string
    shell?: string
    cols?: number
    rows?: number
    title?: string
    command?: string
    env?: Record<string, string>
  }): Omit<TerminalSessionRecord, 'buffer'> {
    this.prune()
    const cwd = input.cwd && existsSync(input.cwd) ? resolve(input.cwd) : olaExternalDataHome()
    const cols = Math.max(20, Math.floor(input.cols ?? 80))
    const rows = Math.max(5, Math.floor(input.rows ?? 24))
    const shell =
      input.shell || process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
    const command = input.command?.trim() || undefined
    const args = command
      ? process.platform === 'win32'
        ? ['/d', '/s', '/c', command]
        : ['-lc', command]
      : []
    const isolatedHome = process.env.OLA_E2E_DATA_ROOT === undefined ? null : olaExternalDataHome()
    const terminal = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        ...input.env,
        ...(isolatedHome
          ? {
              HOME: isolatedHome,
              USERPROFILE: isolatedHome,
              XDG_CONFIG_HOME: resolve(isolatedHome, '.config')
            }
          : {}),
        TERM: 'xterm-256color',
        COLUMNS: String(cols),
        LINES: String(rows)
      }
    })
    const record: Session = {
      id: `term-${randomUUID().replaceAll('-', '')}`,
      workspaceId: input.workspaceId?.trim() || 'local-personal',
      shell,
      cwd,
      cols,
      rows,
      createdAt: Date.now(),
      title: input.title?.trim() || basename(shell) || shell,
      ...(command ? { command } : {}),
      buffer: [],
      bufferBytes: 0,
      pty: terminal
    }
    this.sessions.set(record.id, record)
    terminal.onData((data) => this.append(record, data))
    terminal.onExit(({ exitCode, signal }) => {
      record.exitCode = exitCode
      if (signal) record.exitSignal = signal
      record.exitedAt = Date.now()
      this.exitListeners.forEach((listener) =>
        listener({ id: record.id, exitCode, ...(signal ? { signal } : {}) })
      )
    })
    return this.snapshotRecord(record, false)
  }

  input(id: string, data: string): { success: true } | { success: false; error: string } {
    const session = this.session(id)
    if (!session) return { success: false, error: 'Terminal not found' }
    try {
      session.pty.write(data)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  resize(
    id: string,
    cols: number,
    rows: number
  ): { success: true } | { success: false; error: string } {
    const session = this.session(id)
    if (!session) return { success: false, error: 'Terminal not found' }
    try {
      session.cols = Math.max(20, Math.floor(cols))
      session.rows = Math.max(5, Math.floor(rows))
      session.pty.resize(session.cols, session.rows)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  kill(id: string): { success: true } | { success: false; error: string } {
    const session = this.session(id)
    if (!session) return { success: false, error: 'Terminal not found' }
    try {
      session.pty.kill()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  get(id: string): TerminalSessionRecord | undefined {
    return this.session(id) && this.snapshotRecord(this.sessions.get(id)!, true)
  }
  list(workspaceId?: string): TerminalSessionRecord[] {
    this.prune()
    return [...this.sessions.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .filter((session) => !workspaceId || session.workspaceId === workspaceId)
      .map((s) => this.snapshotRecord(s, true))
  }
  killAll(): void {
    for (const id of this.sessions.keys()) this.kill(id)
    this.sessions.clear()
  }
  private session(id: string): Session | undefined {
    this.prune()
    return this.sessions.get(id)
  }
  private append(session: Session, data: string): void {
    const chunk = { seq: (session.buffer.at(-1)?.seq ?? 0) + 1, data }
    session.buffer.push(chunk)
    session.bufferBytes += Buffer.byteLength(data)
    while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length)
      session.bufferBytes -= Buffer.byteLength(session.buffer.shift()!.data)
    this.outputListeners.forEach((listener) => listener({ id: session.id, ...chunk }))
  }
  private snapshotRecord(session: Session, includeBuffer: boolean): TerminalSessionRecord {
    const { pty: _pty, bufferBytes: _bufferBytes, exitedAt: _exitedAt, ...record } = session
    return { ...record, buffer: includeBuffer ? [...record.buffer] : [] }
  }
  private prune(): void {
    const now = Date.now()
    for (const [id, s] of this.sessions)
      if (s.exitedAt && now - s.exitedAt > RETENTION_MS) this.sessions.delete(id)
  }
}
