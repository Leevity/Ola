import type { SshSession } from '../../../../shared/ssh-contract'
import type { SshStore } from '../ssh-store'

export interface SshSessionsSlice {
  sessions: Record<string, SshSession>
  activeTerminalId: string | null
  connect: (connectionId: string) => Promise<string | null>
  openTerminalTab: (connectionId: string, projectId?: string | null) => Promise<string | null>
  disconnect: (sessionId: string) => Promise<void>
  setActiveTerminal: (sessionId: string | null) => void
  updateSessionStatus: (sessionId: string, status: SshSession['status'], error?: string) => void
  removeSession: (sessionId: string) => void
}

export const selectSshSessions = (state: SshStore): SshStore['sessions'] => state.sessions
export const selectActiveSshTerminal = (state: SshStore): string | null => state.activeTerminalId
