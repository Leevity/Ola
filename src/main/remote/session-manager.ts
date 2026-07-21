import type { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'

export type RemoteSessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export type RemoteSession = {
  id: string
  kind: 'rdp' | 'vnc' | 'ola-device'
  connectionId?: string | null
  status: RemoteSessionStatus
  error?: string | null
  viewerUrl?: string | null
  viewerType?: 'rdp' | 'vnc' | null
  viewerDestination?: string | null
  credentialAvailable?: boolean
  createdAt: number
  updatedAt: number
}

type ManagedRemoteSession = RemoteSession & {
  process?: ChildProcess | null
  cleanup?: (() => void) | null
  forceKillTimer?: NodeJS.Timeout | null
  disconnectRequested?: boolean
}

const VIEWER_EXIT_TIMEOUT_MS = 3_000

function now(): number {
  return Date.now()
}

export class RemoteSessionManager {
  private readonly sessions = new Map<string, ManagedRemoteSession>()
  private readonly events = new EventEmitter()

  subscribe(listener: (session: RemoteSession) => void): () => void {
    this.events.on('changed', listener)
    return () => this.events.off('changed', listener)
  }

  list(): RemoteSession[] {
    return [...this.sessions.values()]
      .map(({ process: _process, ...session }) => session)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  create(
    session: Omit<RemoteSession, 'createdAt' | 'updatedAt'>,
    process?: ChildProcess | null,
    cleanup?: (() => void) | null
  ): RemoteSession {
    const timestamp = now()
    const managed: ManagedRemoteSession = {
      ...session,
      process,
      cleanup,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.sessions.set(session.id, managed)
    process?.once('exit', (code) => {
      this.clearForceKillTimer(session.id)
      this.patch(session.id, {
        status:
          managed.disconnectRequested || code === 0 || code === null ? 'disconnected' : 'error',
        error:
          managed.disconnectRequested || code === 0 || code === null
            ? null
            : `Remote viewer exited with code ${code}`
      })
    })
    process?.once('error', (error) => {
      this.patch(session.id, { status: 'error', error: error.message })
    })
    const created = this.toPublicSession(managed)
    this.events.emit('changed', created)
    return created
  }

  patch(id: string, patch: Partial<Pick<RemoteSession, 'status' | 'error'>>): RemoteSession | null {
    const session = this.sessions.get(id)
    if (!session) return null
    const next = { ...session, ...patch, updatedAt: now() }
    this.sessions.set(id, next)
    const updated = this.toPublicSession(next)
    this.events.emit('changed', updated)
    return updated
  }

  disconnect(id: string): RemoteSession | null {
    const session = this.sessions.get(id)
    if (!session) return null
    if (session.disconnectRequested || session.status === 'disconnected') {
      return this.toPublicSession(session)
    }
    session.disconnectRequested = true
    session.cleanup?.()
    session.cleanup = null
    if (session.process?.exitCode === null && !session.process.killed) {
      session.process.kill('SIGTERM')
      const timer = setTimeout(() => {
        const current = this.sessions.get(id)
        if (current?.process?.exitCode === null) current.process.kill('SIGKILL')
        this.clearForceKillTimer(id)
      }, VIEWER_EXIT_TIMEOUT_MS)
      timer.unref()
      session.forceKillTimer = timer
    }
    const next = { ...session, status: 'disconnected' as const, error: null, updatedAt: now() }
    this.sessions.set(id, next)
    const disconnected = this.toPublicSession(next)
    this.events.emit('changed', disconnected)
    return disconnected
  }

  disconnectAll(): void {
    for (const session of this.sessions.values()) this.disconnect(session.id)
  }

  private clearForceKillTimer(id: string): void {
    const session = this.sessions.get(id)
    if (!session?.forceKillTimer) return
    clearTimeout(session.forceKillTimer)
    session.forceKillTimer = null
  }

  private toPublicSession(session: ManagedRemoteSession): RemoteSession {
    const {
      process: _process,
      cleanup: _cleanup,
      forceKillTimer: _forceKillTimer,
      disconnectRequested: _disconnectRequested,
      ...publicSession
    } = session
    return publicSession
  }
}
