import type { SshStore } from '../ssh-store'

export const selectSshConnections = (state: SshStore): SshStore['connections'] => state.connections
export const selectSshGroups = (state: SshStore): SshStore['groups'] => state.groups
export const selectSelectedSshConnection = (state: SshStore): string | null =>
  state.selectedConnectionId
