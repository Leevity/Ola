import { getTsDatabaseRouteGuard } from './business-write-canary'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import {
  canaryGetRawUsageRows,
  canaryGetUsageActivity,
  canaryGetUsageOverview,
  canaryListUsageEvents
} from './legacy-read-canary'
import { businessWriteCanary } from './business-write-canary'

let cleanupInFlight: Promise<UsageEventsCleanupResult> | null = null

export interface UsageEventRow {
  id: string
  workspace_id?: string
  created_at: number
  request_started_at: number | null
  request_finished_at: number | null
  session_id: string | null
  message_id: string | null
  project_id: string | null
  source_kind: string
  provider_id: string | null
  provider_name: string | null
  provider_type: string | null
  provider_builtin_id: string | null
  provider_base_url: string | null
  model_id: string | null
  model_name: string | null
  model_category: string | null
  request_type: string | null
  input_tokens: number
  billable_input_tokens: number | null
  output_tokens: number
  cache_creation_tokens: number | null
  cache_read_tokens: number | null
  reasoning_tokens: number | null
  context_tokens: number | null
  input_price: number | null
  output_price: number | null
  cache_creation_price: number | null
  cache_hit_price: number | null
  input_cost_usd: number | null
  output_cost_usd: number | null
  cache_creation_cost_usd: number | null
  cache_hit_cost_usd: number | null
  total_cost_usd: number | null
  ttft_ms: number | null
  total_ms: number | null
  tps: number | null
  provider_response_id: string | null
  request_debug_json: string | null
  usage_raw_json: string | null
  meta_json: string | null
}

export interface UsageEventsQuery {
  from: number
  to: number
  workspaceId?: string
  providerId?: string | null
  modelId?: string | null
  sourceKind?: string | null
  limit?: number
  offset?: number
}

export interface UsageActivityQuery {
  from: number
  to: number
  workspaceId?: string
  limit?: number
  offset?: number
}

export type UsageTimelineBucket = 'hour' | 'day'

export interface UsageEventsCleanupResult {
  cutoff: number
  deleted: number
}

interface NativeUsageMaintenanceResult extends UsageEventsCleanupResult {
  success: boolean
  dbPath: string
  error?: string | null
}

export type UsageEventListRow = Omit<
  UsageEventRow,
  'request_debug_json' | 'usage_raw_json' | 'meta_json'
> & {
  request_debug_chars: number
  usage_raw_chars: number
  meta_chars: number
}

interface NativeUsageAnalyticsResult {
  success: boolean
  row?: Record<string, unknown> | null
  rows?: Record<string, unknown>[] | null
  deleted?: number
  error?: string | null
}

interface NativeUsageAddEventResult {
  success: boolean
  dbPath: string
  id?: string | null
  createdAt?: number | null
  error?: string | null
}

async function usageQuery(
  operation: string,
  params: object,
  timeoutMs = 120_000
): Promise<NativeUsageAnalyticsResult> {
  const workspaceId = await requireUsageWorkspace((params as { workspaceId?: string }).workspaceId)
  const result = await getTsDatabaseRouteGuard().request<NativeUsageAnalyticsResult>(
    'db/usage-query',
    { operation, ...params, workspaceId },
    timeoutMs
  )
  if (!result.success) {
    throw new Error(result.error || 'Native usage query failed: ' + operation)
  }
  if (operation !== 'delete') await requireUsageWorkspace(workspaceId)
  return result
}

async function requireUsageWorkspace(raw?: string): Promise<string> {
  const workspaceId = raw ?? 'local-personal'
  if (!workspaceId || workspaceId !== workspaceId.trim())
    throw new Error('Usage workspace is invalid')
  if (workspaceId !== 'local-personal' && !(await loadOfflineWorkspaceIds()).has(workspaceId))
    throw new Error('Usage workspace is not available')
  return workspaceId
}

async function usageQueryRow(operation: string, params: object): Promise<Record<string, unknown>> {
  const result = await usageQuery(operation, params)
  return result.row ?? {}
}

async function usageQueryRows(
  operation: string,
  params: object
): Promise<Record<string, unknown>[]> {
  const result = await usageQuery(operation, params)
  return result.rows ?? []
}

export async function addUsageEvent(
  event: Omit<UsageEventRow, 'created_at'> & { created_at?: number }
): Promise<void> {
  const workspaceId = await requireUsageWorkspace(event.workspace_id)
  const writer = businessWriteCanary()
  if (writer) {
    await writer.addUsageEvent({
      ...event,
      workspace_id: workspaceId,
      created_at: event.created_at ?? Date.now()
    })
    return
  }
  const result = await getTsDatabaseRouteGuard().request<NativeUsageAddEventResult>(
    'db/usage-add-event',
    { ...event, workspace_id: workspaceId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native usage event insert failed')
  }
}

export function getUsageOverview(query: UsageEventsQuery): Promise<Record<string, unknown>> {
  return getUsageOverviewInternal(query)
}

async function getUsageOverviewInternal(query: UsageEventsQuery): Promise<Record<string, unknown>> {
  const workspaceId = await requireUsageWorkspace(query.workspaceId)
  const canary = await canaryGetUsageOverview<Record<string, unknown>>({ ...query, workspaceId })
  if (canary !== undefined) {
    await requireUsageWorkspace(workspaceId)
    return canary
  }
  const writer = businessWriteCanary()
  if (writer) {
    return (
      (await writer.usageOverview<Record<string, unknown>>({
        ...query,
        workspaceId
      })) ?? {}
    )
  }
  return usageQueryRow('overview', { ...query, workspaceId })
}

export function getUsageDaily(query: UsageEventsQuery): Promise<Record<string, unknown>[]> {
  return rawUsageRowsWithCanary('daily', query)
}

export function getUsageTimeline(
  query: UsageEventsQuery,
  bucket: UsageTimelineBucket
): Promise<Record<string, unknown>[]> {
  return rawUsageRowsWithCanary('timeline', { ...query, bucket })
}

export function getUsageByModel(query: UsageEventsQuery): Promise<Record<string, unknown>[]> {
  return rawUsageRowsWithCanary('by-model', query)
}

export function getUsageByProvider(query: UsageEventsQuery): Promise<Record<string, unknown>[]> {
  return rawUsageRowsWithCanary('by-provider', query)
}

async function rawUsageRowsWithCanary(
  operation: 'daily' | 'timeline' | 'by-model' | 'by-provider',
  query: UsageEventsQuery & { bucket?: UsageTimelineBucket }
): Promise<Record<string, unknown>[]> {
  const workspaceId = await requireUsageWorkspace(query.workspaceId)
  const canary = await canaryGetRawUsageRows<Record<string, unknown>>(operation, {
    ...query,
    workspaceId
  })
  if (canary !== undefined) {
    await requireUsageWorkspace(workspaceId)
    return canary
  }
  const writer = businessWriteCanary()
  if (writer) {
    return writer.usageRawRows<Record<string, unknown>>(operation, {
      ...query,
      workspaceId
    })
  }
  return usageQueryRows(operation, { ...query, workspaceId })
}

export function getUsageActivityOverview(
  query: UsageActivityQuery
): Promise<Record<string, unknown>> {
  return usageActivityWithCanary('activity-overview', query) as Promise<Record<string, unknown>>
}

export function getUsageActivityDaily(
  query: UsageActivityQuery
): Promise<Record<string, unknown>[]> {
  return usageActivityWithCanary('activity-daily', query) as Promise<Record<string, unknown>[]>
}

export function getUsageActivityByModel(
  query: UsageActivityQuery
): Promise<Record<string, unknown>[]> {
  return usageActivityWithCanary('activity-by-model', query) as Promise<Record<string, unknown>[]>
}

export function getUsageActivityByProvider(
  query: UsageActivityQuery
): Promise<Record<string, unknown>[]> {
  return usageActivityWithCanary('activity-by-provider', query) as Promise<
    Record<string, unknown>[]
  >
}

async function usageActivityWithCanary(
  operation: 'activity-overview' | 'activity-daily' | 'activity-by-model' | 'activity-by-provider',
  query: UsageActivityQuery
): Promise<Record<string, unknown> | Record<string, unknown>[]> {
  const workspaceId = await requireUsageWorkspace(query.workspaceId)
  const canary = await canaryGetUsageActivity<Record<string, unknown>>(operation, {
    ...query,
    workspaceId
  })
  if (canary !== undefined) {
    await requireUsageWorkspace(workspaceId)
    return operation === 'activity-overview' ? (canary.row ?? {}) : (canary.rows ?? [])
  }
  const writer = businessWriteCanary()
  if (writer) {
    const result = await writer.queryActivityUsage<Record<string, unknown>>(operation, {
      ...query,
      workspaceId
    })
    return operation === 'activity-overview' ? (result.row ?? {}) : (result.rows ?? [])
  }
  return operation === 'activity-overview'
    ? usageQueryRow(operation, { ...query, workspaceId })
    : usageQueryRows(operation, { ...query, workspaceId })
}

export async function deleteUsageEvents(query: UsageEventsQuery): Promise<{ deleted: number }> {
  const workspaceId = await requireUsageWorkspace(query.workspaceId)
  const writer = businessWriteCanary()
  if (writer) {
    return {
      deleted: await writer.deleteUsageEvents({
        ...query,
        workspaceId,
        from: query.from,
        to: query.to
      })
    }
  }
  const result = await usageQuery('delete', query)
  return { deleted: result.deleted ?? 0 }
}

async function cleanupExpiredUsageEventsInternal(): Promise<UsageEventsCleanupResult> {
  const writer = businessWriteCanary()
  if (writer) return writer.maintainUsage(Date.now())
  const result = await getTsDatabaseRouteGuard().request<NativeUsageMaintenanceResult>(
    'db/usage-maintenance',
    {},
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native usage maintenance failed')
  }

  return {
    cutoff: result.cutoff,
    deleted: result.deleted
  }
}

export function cleanupExpiredUsageEvents(): Promise<UsageEventsCleanupResult> {
  if (!cleanupInFlight) {
    cleanupInFlight = cleanupExpiredUsageEventsInternal().finally(() => {
      cleanupInFlight = null
    })
  }

  return cleanupInFlight
}

export function listUsageEvents(query: UsageEventsQuery): Promise<UsageEventListRow[]> {
  return listUsageEventsInternal(query)
}

async function listUsageEventsInternal(query: UsageEventsQuery): Promise<UsageEventListRow[]> {
  const workspaceId = await requireUsageWorkspace(query.workspaceId)
  const canary = await canaryListUsageEvents<UsageEventListRow>({ ...query, workspaceId })
  if (canary !== undefined) {
    await requireUsageWorkspace(workspaceId)
    return canary
  }
  const writer = businessWriteCanary()
  if (writer) {
    return writer.usageEvents<UsageEventListRow>({
      ...query,
      workspaceId,
      limit: query.limit,
      offset: query.offset
    })
  }
  return usageQueryRows('list', { ...query, workspaceId }) as Promise<UsageEventListRow[]>
}
