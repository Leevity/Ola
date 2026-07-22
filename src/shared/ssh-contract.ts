export interface SshGroup {
  id: string
  name: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface SshConnection {
  id: string
  groupId: string | null
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey' | 'agent'
  privateKeyPath: string | null
  startupCommand: string | null
  defaultDirectory: string | null
  proxyJump: string | null
  keepAliveInterval: number
  sortOrder: number
  lastConnectedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface SshSession {
  id: string
  connectionId: string
  status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'
  error?: string
}

export type SshDiagnosticStage = 'dial' | 'handshake' | 'auth' | 'shell' | 'reconnect'
export interface SshDiagnosticEntry {
  id: number
  sessionId: string
  connectionId: string
  stage: SshDiagnosticStage
  level: 'info' | 'error'
  message: string
  timestamp: number
}

export interface SshTab {
  id: string
  type: 'terminal' | 'file'
  sessionId: string | null
  connectionId: string
  connectionName: string
  title: string
  projectId?: string | null
  filePath?: string
  status?: 'connecting' | 'connected' | 'error'
  error?: string
}

export interface SshFileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink'
  size: number
  modifyTime: number
}

export type SshWorkspaceSection =
  | 'hosts'
  | 'keychain'
  | 'forwarding'
  | 'snippets'
  | 'knownHosts'
  | 'logs'
  | 'sftp'
  | 'terminal'

export type SshUploadStage = 'upload' | 'cleanup' | 'done' | 'error' | 'canceled'
export type SshUploadProgress = { current?: number; total?: number; percent?: number }
export type SshUploadTask = {
  taskId: string
  connectionId: string
  stage: SshUploadStage
  progress?: SshUploadProgress
  message?: string
  updatedAt: number
}

export type SftpPaneId = 'left' | 'right'
export type SftpConflictPolicy = 'skip' | 'overwrite' | 'duplicate'
export type SftpTransferTaskType = 'upload' | 'download' | 'remote-copy'
export type SftpTransferRequest =
  | {
      type: 'upload'
      connectionId: string
      remoteDir: string
      localPaths: string[]
      conflictPolicy?: SftpConflictPolicy
      resume?: boolean
    }
  | {
      type: 'download'
      connectionId: string
      remotePaths: string[]
      localDir: string
      conflictPolicy?: SftpConflictPolicy
      resume?: boolean
    }
  | {
      type: 'remote-copy'
      sourceConnectionId: string
      targetConnectionId: string
      sourcePaths: string[]
      targetDir: string
      conflictPolicy?: SftpConflictPolicy
      resume?: boolean
    }
export type SftpTransferStage =
  | 'preparing'
  | 'transferring'
  | 'cleanup'
  | 'done'
  | 'error'
  | 'canceled'
export type SftpTransferProgress = {
  currentBytes?: number
  totalBytes?: number
  percent?: number
  processedItems?: number
  totalItems?: number
}
export type SftpTransferTask = {
  taskId: string
  type: SftpTransferTaskType
  stage: SftpTransferStage
  sourceConnectionId?: string | null
  targetConnectionId?: string | null
  progress?: SftpTransferProgress
  message?: string
  currentItem?: string
  updatedAt: number
  conflictPolicy?: SftpConflictPolicy
  request?: SftpTransferRequest
}
export type SftpConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error'
export type SftpConnectionState = {
  status: SftpConnectionStatus
  error?: string
  homeDir?: string | null
  lastConnectedAt?: number
}
export type SftpPaneState = { connectionId: string | null; currentPath: string | null }
export type SftpInspectorTab = 'details' | 'tasks'
