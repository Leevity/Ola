import type { WorkspaceSyncBundle } from '../../shared/sync-types'
import type { BusinessDrawRunInput } from './business-repository'

export interface DrawSyncRow {
  id: string
  workspace_id: string
  prompt: string
  provider_name: string
  model_name: string
  mode: string
  meta_json: string | null
  created_at: number
  is_generating: number
  images_json: string
  error_json: string | null
  updated_at: number
}

const DOMAIN = 'db:draw_runs'

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    value === value.trim() &&
    value.length <= 1024
  )
}

function validJson(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 20_000_000) return false
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

/** Validate every remote draw row before a merged bundle can be uploaded. */
export function drawRecordInput(
  record: WorkspaceSyncBundle['records'][number],
  workspaceId: string
): BusinessDrawRunInput {
  if (record.domain !== DOMAIN || !record.value || typeof record.value !== 'object')
    throw new Error('SYNC_DRAW_DOMAIN_UNSUPPORTED')
  const value = record.value as { table?: unknown; row?: unknown }
  if (value.table !== 'draw_runs' || !value.row || typeof value.row !== 'object')
    throw new Error('SYNC_DRAW_ROW_INVALID')
  const row = value.row as DrawSyncRow
  if (
    row.workspace_id !== workspaceId ||
    !validId(row.id) ||
    row.id !== record.recordId ||
    !validId(row.workspace_id) ||
    typeof row.prompt !== 'string' ||
    !row.prompt.trim() ||
    row.prompt.length > 20_000_000 ||
    !validId(row.provider_name) ||
    !validId(row.model_name) ||
    !validId(row.mode) ||
    (row.meta_json !== null && !validJson(row.meta_json)) ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at < 0 ||
    (row.is_generating !== 0 && row.is_generating !== 1) ||
    !validJson(row.images_json) ||
    (row.error_json !== null && !validJson(row.error_json)) ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at < 0 ||
    (record.updatedAt != null && record.updatedAt !== row.updated_at)
  )
    throw new Error('SYNC_DRAW_ROW_INVALID')
  return {
    id: row.id,
    workspaceId,
    prompt: row.prompt,
    providerName: row.provider_name,
    modelName: row.model_name,
    mode: row.mode,
    metaJson: row.meta_json,
    createdAt: row.created_at,
    isGenerating: row.is_generating === 1,
    imagesJson: row.images_json,
    errorJson: row.error_json,
    updatedAt: row.updated_at
  }
}
