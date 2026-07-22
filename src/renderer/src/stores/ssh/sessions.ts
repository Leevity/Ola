import type { SshStore } from '../ssh-store'

export const selectSshSessions = (state: SshStore): SshStore['sessions'] => state.sessions
export const selectActiveSshTerminal = (state: SshStore): string | null => state.activeTerminalId
