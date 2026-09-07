import type { SshConnection, SshGroup } from '../../../../shared/ssh-contract'
import type { SshStore } from '../ssh-store'

export interface SshConnectionsSlice {
  groups: SshGroup[]
  connections: SshConnection[]
  selectedConnectionId: string | null
  _loaded: boolean
  loadAll: () => Promise<void>
  createGroup: (name: string) => Promise<string>
  updateGroup: (id: string, name: string) => Promise<void>
  deleteGroup: (id: string) => Promise<void>
  createConnection: (data: SshConnectionCreateInput) => Promise<string>
  updateConnection: (id: string, data: SshConnectionUpdateInput) => Promise<void>
  deleteConnection: (id: string) => Promise<void>
  testConnection: (id: string) => Promise<{ success: boolean; error?: string }>
  setSelectedConnection: (connectionId: string | null) => void
}

export interface SshConnectionCreateInput {
  name: string
  host: string
  port?: number
  username: string
  authType?: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  groupId?: string
  startupCommand?: string
  defaultDirectory?: string
  proxyJump?: string
  keepAliveInterval?: number
}

export interface SshConnectionUpdateInput {
  name?: string
  host?: string
  port?: number
  username?: string
  authType?: string
  password?: string | null
  privateKeyPath?: string | null
  passphrase?: string | null
  groupId?: string | null
  startupCommand?: string | null
  defaultDirectory?: string | null
  proxyJump?: string | null
  keepAliveInterval?: number
}

export const selectSshConnections = (state: SshStore): SshStore['connections'] => state.connections
export const selectSshGroups = (state: SshStore): SshStore['groups'] => state.groups
export const selectSelectedSshConnection = (state: SshStore): string | null =>
  state.selectedConnectionId
