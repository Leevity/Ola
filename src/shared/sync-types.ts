export type SyncProviderType = 'webdav'

export type SyncRunMode = 'sync' | 'push' | 'pull'

export type SyncRunStatus = 'idle' | 'running' | 'success' | 'conflict' | 'error'

export interface WebDavSyncConfig {
  displayName: string
  serverUrl: string
  username: string
  password: string
  remoteDir: string
  autoSyncEnabled: boolean
  syncIntervalMinutes: number
  backupRetention: number
}

export interface SyncProviderConfig {
  id: string
  type: SyncProviderType
  enabled: boolean
  webdav: WebDavSyncConfig
}

export interface SyncConfig {
  deviceId: string
  activeProviderId: string
  providers: SyncProviderConfig[]
  lastRun?: SyncRunSummary | null
}

export interface SyncProviderDescriptor {
  type: SyncProviderType
  displayName: string
  description: string
}

export interface SyncBundleManifest {
  schemaVersion: number
  appVersion: string
  deviceId: string
  createdAt: number
  contentHash: string
  domains: Record<string, number>
  tombstones: number
}

export interface SyncRecord {
  domain: string
  recordId: string
  hash: string
  value: unknown
  updatedAt?: number | null
}

export interface SyncTombstone {
  domain: string
  recordId: string
  deletedAt: number
  originDeviceId: string
}

export interface SyncBundle {
  manifest: SyncBundleManifest
  records: SyncRecord[]
  tombstones: SyncTombstone[]
}

export type SyncConflictKind = 'modify-modify' | 'delete-modify' | 'create-create'

export interface SyncConflict {
  id: string
  kind: SyncConflictKind
  domain: string
  recordId: string
  localHash?: string | null
  remoteHash?: string | null
  baselineHash?: string | null
  localValue?: unknown
  remoteValue?: unknown
  localDeleted?: boolean
  remoteDeleted?: boolean
}

export interface SyncConflictResolution {
  conflictId: string
  choice: 'local' | 'remote'
}

export interface SyncRunSummary {
  id: string
  providerId: string
  mode: SyncRunMode
  status: SyncRunStatus
  startedAt: number
  finishedAt?: number | null
  uploadedRecords: number
  downloadedRecords: number
  deletedRecords: number
  conflicts: number
  remoteUpdatedAt?: number | null
  error?: string | null
}

export interface SyncStatus {
  status: SyncRunStatus
  running: boolean
  deviceId: string
  activeProviderId: string
  lastRun?: SyncRunSummary | null
  pendingConflicts: SyncConflict[]
}

export interface SyncConnectionTestResult {
  success: boolean
  error?: string
}
