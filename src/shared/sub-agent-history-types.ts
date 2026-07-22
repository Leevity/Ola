export type SubAgentHistoryStoredStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface SubAgentHistoryRow {
  id: string
  sessionId: string
  subAgentId: string
  toolUseId: string
  name: string
  status: SubAgentHistoryStoredStatus
  startedAt: number
  completedAt: number | null
  updatedAt: number
  sortOrder: number
  snapshotJson: string | null
}

export interface SubAgentHistoryPage {
  items: SubAgentHistoryRow[]
  offset: number
  limit: number
  hasMore: boolean
}

export interface SubAgentHistoryUpsertItem extends Omit<SubAgentHistoryRow, 'snapshotJson'> {
  snapshotJson: string
}

export interface SubAgentHistoryMutation {
  success: boolean
  changed: number
  error?: string | null
}

export interface SubAgentHistoryMigrationStatus {
  applied: boolean
  appliedAt: number | null
}
