import { randomUUID } from 'node:crypto'
import { getTsDatabaseRouteGuard } from './business-write-canary'
import { canaryGetGoal, canaryListGoalEvents, canaryListGoals } from './legacy-read-canary'
import { businessWriteCanary } from './business-write-canary'

export type SessionGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usage_limited'
  | 'budget_limited'
  | 'complete'
export type SessionGoalEventType =
  | 'created'
  | 'replaced'
  | 'objective_updated'
  | 'budget_updated'
  | 'status_changed'
  | 'usage_accounted'
  | 'usage_limited'
  | 'budget_limited'
  | 'completion_deferred'
  | 'blocked'
  | 'completed'
  | 'stall_paused'
  | 'auto_continue_blocked'
  | 'cleared'

export interface SessionGoalRow {
  session_id: string
  goal_id: string
  objective: string
  status: SessionGoalStatus
  token_budget: number | null
  tokens_used: number
  time_used_seconds: number
  created_at: number
  updated_at: number
}

export interface SessionGoalEventRow {
  id: string
  session_id: string
  goal_id: string | null
  event_type: SessionGoalEventType
  message: string | null
  metadata_json: string | null
  created_at: number
}

export interface SessionGoalUpdate {
  objective?: string
  status?: SessionGoalStatus
  tokenBudget?: number | null
}

export interface AccountGoalUsageArgs {
  sessionId: string
  workspaceId: string
  timeDeltaSeconds: number
  tokenDelta: number
  expectedGoalId?: string | null
}

export interface AddGoalEventArgs {
  sessionId: string
  workspaceId: string
  goalId?: string | null
  eventType: SessionGoalEventType
  message?: string | null
  metadata?: Record<string, unknown> | null
  createdAt?: number
}

interface NativeGoalFindResult {
  success: boolean
  goal?: SessionGoalRow | null
  error?: string | null
}

interface NativeGoalClearResult {
  success: boolean
  cleared: boolean
  error?: string | null
}

function unwrapGoalResult(result: NativeGoalFindResult, operation: string): SessionGoalRow | null {
  if (!result.success) {
    throw new Error(result.error || `Native goal ${operation} failed`)
  }
  return result.goal ?? null
}

export async function addGoalEvent(args: AddGoalEventArgs): Promise<SessionGoalEventRow> {
  const writer = businessWriteCanary()
  if (writer) {
    const id = `oc_${randomUUID().replaceAll('-', '')}`
    await writer.appendGoalEvent({
      id,
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      goalId: args.goalId,
      eventType: args.eventType,
      message: args.message,
      metadata: args.metadata,
      createdAt: args.createdAt ?? Date.now()
    })
    const row = (
      await writer.goalEvents<SessionGoalEventRow>(args.sessionId, args.workspaceId)
    ).find((event) => event.id === id)
    if (!row) throw new Error('TS_BUSINESS_GOAL_EVENT_NOT_FOUND_AFTER_WRITE')
    return row
  }
  return getTsDatabaseRouteGuard().request<SessionGoalEventRow>('db/goal-events-add', args, 120_000)
}

export async function listGoalEvents(args: {
  sessionId: string
  workspaceId?: string
  goalId?: string | null
  limit?: number
}): Promise<SessionGoalEventRow[]> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!args.workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    return await writer.goalEvents<SessionGoalEventRow>(args.sessionId, args.workspaceId, {
      goalId: args.goalId,
      limit: args.limit
    })
  }
  const migrated = await canaryListGoalEvents(args)
  if (migrated) return migrated as SessionGoalEventRow[]
  return getTsDatabaseRouteGuard().request<SessionGoalEventRow[]>(
    'db/goal-events-list',
    args,
    120_000
  )
}

export async function listGoals(workspaceId: string): Promise<SessionGoalRow[]> {
  const writer = businessWriteCanary()
  if (writer) return await writer.goals<SessionGoalRow>(workspaceId)
  const migrated = await canaryListGoals(workspaceId)
  if (migrated) return migrated as SessionGoalRow[]
  return getTsDatabaseRouteGuard().request<SessionGoalRow[]>(
    'db/goals-list',
    { workspaceId },
    120_000
  )
}

export async function getGoal(
  sessionId: string,
  workspaceId?: string
): Promise<SessionGoalRow | undefined> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    return (await writer.goal<SessionGoalRow>(sessionId, workspaceId)) ?? undefined
  }
  const migrated = await canaryGetGoal(sessionId, workspaceId)
  if (migrated !== undefined) return (migrated as SessionGoalRow | null) ?? undefined
  const result = await getTsDatabaseRouteGuard().request<NativeGoalFindResult>(
    'db/goals-get',
    { sessionId, workspaceId },
    120_000
  )
  return unwrapGoalResult(result, 'get') ?? undefined
}

export async function createGoal(args: {
  sessionId: string
  workspaceId: string
  objective: string
  tokenBudget?: number | null
}): Promise<SessionGoalRow | null> {
  const writer = businessWriteCanary()
  if (writer) return writer.createGoal<SessionGoalRow>(args)
  const result = await getTsDatabaseRouteGuard().request<NativeGoalFindResult>(
    'db/goals-create',
    args,
    120_000
  )
  return unwrapGoalResult(result, 'create')
}

export function replaceGoal(args: {
  sessionId: string
  workspaceId: string
  objective: string
  status?: SessionGoalStatus
  tokenBudget?: number | null
}): Promise<SessionGoalRow> {
  const writer = businessWriteCanary()
  if (writer) return writer.replaceGoal<SessionGoalRow>(args)
  return getTsDatabaseRouteGuard().request<SessionGoalRow>('db/goals-replace', args, 120_000)
}

export async function updateGoal(
  sessionId: string,
  patch: SessionGoalUpdate,
  workspaceId: string
): Promise<SessionGoalRow | null> {
  const writer = businessWriteCanary()
  if (writer)
    return writer.updateGoal<SessionGoalRow>({
      sessionId,
      workspaceId,
      patch,
      updatedAt: Date.now()
    })
  const result = await getTsDatabaseRouteGuard().request<NativeGoalFindResult>(
    'db/goals-update',
    { sessionId, patch, workspaceId },
    120_000
  )
  return unwrapGoalResult(result, 'update')
}

export async function clearGoal(sessionId: string, workspaceId: string): Promise<boolean> {
  const writer = businessWriteCanary()
  if (writer) return (await writer.clearGoal({ sessionId, workspaceId })).cleared
  const result = await getTsDatabaseRouteGuard().request<NativeGoalClearResult>(
    'db/goals-clear',
    { sessionId, workspaceId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native goal clear failed')
  }
  return result.cleared
}

export async function accountGoalUsage(args: AccountGoalUsageArgs): Promise<SessionGoalRow | null> {
  const writer = businessWriteCanary()
  if (writer) return writer.accountGoalUsage<SessionGoalRow>(args)
  const result = await getTsDatabaseRouteGuard().request<NativeGoalFindResult>(
    'db/goals-account',
    args,
    120_000
  )
  return unwrapGoalResult(result, 'account')
}
