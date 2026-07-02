export type MigrationSource = 'opencode'

export type MigrationAction = 'create' | 'skip' | 'replace' | 'duplicate'

export type MigrationItemKind =
  | 'provider'
  | 'mainModelSelection'
  | 'fastModelSelection'
  | 'command'
  | 'agent'
  | 'mcp'
  | 'instructions'

export interface MigrationPreviewDetail {
  label: string
  value: string
}

export interface MigrationPreviewItem {
  id: string
  kind: MigrationItemKind
  title: string
  sourceLabel: string
  targetLabel: string
  targetPath?: string
  conflict: boolean
  defaultAction: MigrationAction
  allowedActions: MigrationAction[]
  warnings: string[]
  unsupportedFields: string[]
  details: MigrationPreviewDetail[]
  payload?: Record<string, unknown>
}

export interface MigrationPreviewSummary {
  total: number
  conflicts: number
  warnings: number
  actionable: number
}

export interface MigrationPreviewResult {
  source: MigrationSource
  sourcePath: string
  detected: boolean
  warnings: string[]
  items: MigrationPreviewItem[]
  summary: MigrationPreviewSummary
  generatedAt: number
}

export interface MigrationApplyDecision {
  id: string
  action: MigrationAction
}

export interface MigrationApplyResultItem {
  id: string
  kind: MigrationItemKind
  title: string
  action: MigrationAction
  status: 'success' | 'skipped' | 'failed'
  targetPath?: string
  message?: string
  warnings?: string[]
}

export interface MigrationApplySummary {
  total: number
  applied: number
  skipped: number
  failed: number
}

export interface MigrationApplyResult {
  source: MigrationSource
  sourcePath: string
  backupPath?: string
  warnings: string[]
  results: MigrationApplyResultItem[]
  summary: MigrationApplySummary
  appliedAt: number
}
