import { getTsDatabaseRouteGuard } from './business-write-canary'
import { canaryGetPlan, canaryGetPlanBySession, canaryListPlans } from './legacy-read-canary'
import { businessWriteCanary } from './business-write-canary'

export interface PlanRow {
  id: string
  session_id: string
  title: string
  status: string
  file_path: string | null
  content: string | null
  spec_json: string | null
  created_at: number
  updated_at: number
  workspace_id: string | null
}

interface PlanFindResult {
  success: boolean
  plan?: PlanRow | null
  error?: string | null
}

interface PlanMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

async function requestMutation(method: string, params: object): Promise<PlanMutationResult> {
  const result = await getTsDatabaseRouteGuard().request<PlanMutationResult>(
    method,
    params,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || `Native plan mutation failed: ${method}`)
  }
  return result
}

export async function listPlans(workspaceId = 'local-personal'): Promise<PlanRow[]> {
  const writer = businessWriteCanary()
  if (writer) return await writer.plans<PlanRow>(workspaceId)
  const migrated = await canaryListPlans(workspaceId)
  if (migrated !== undefined) return migrated
  return getTsDatabaseRouteGuard().request<PlanRow[]>('db/plans-list', { workspaceId }, 120_000)
}

export async function getPlan(
  id: string,
  workspaceId = 'local-personal'
): Promise<PlanRow | undefined> {
  const writer = businessWriteCanary()
  if (writer) return (await writer.plan<PlanRow>(id, workspaceId)) ?? undefined
  const migrated = await canaryGetPlan(id, workspaceId)
  if (migrated !== undefined) return migrated ?? undefined
  const result = await getTsDatabaseRouteGuard().request<PlanFindResult>(
    'db/plans-get',
    { id, workspaceId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native plan get failed')
  }
  return result.plan ?? undefined
}

export async function getPlanBySession(
  sessionId: string,
  workspaceId = 'local-personal'
): Promise<PlanRow | undefined> {
  const writer = businessWriteCanary()
  if (writer) return (await writer.planBySession<PlanRow>(sessionId, workspaceId)) ?? undefined
  const migrated = await canaryGetPlanBySession(sessionId, workspaceId)
  if (migrated !== undefined) return migrated ?? undefined
  const result = await getTsDatabaseRouteGuard().request<PlanFindResult>(
    'db/plans-get-by-session',
    { sessionId, workspaceId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native plan session lookup failed')
  }
  return result.plan ?? undefined
}

export async function createPlan(plan: {
  id: string
  sessionId: string
  title: string
  status?: string
  filePath?: string
  content?: string
  specJson?: string
  workspaceId?: string
  createdAt: number
  updatedAt: number
}): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    const workspaceId = plan.workspaceId ?? 'local-personal'
    await writer.createPlan<PlanRow>({
      id: plan.id,
      sessionId: plan.sessionId,
      workspaceId,
      title: plan.title,
      status: plan.status ?? 'drafting',
      filePath: plan.filePath ?? null,
      content: plan.content ?? null,
      spec: plan.specJson ? JSON.parse(plan.specJson) : null,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt
    })
    return
  }
  await requestMutation('db/plans-create', {
    ...plan,
    workspaceId: plan.workspaceId ?? 'local-personal'
  })
}

export async function updatePlan(
  id: string,
  workspaceId: string,
  patch: Partial<{
    title: string
    status: string
    filePath: string | null
    content: string | null
    specJson: string | null
    updatedAt: number
  }>
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.updatePlan<PlanRow>({
      id,
      workspaceId,
      ...patch,
      spec: patch.specJson ? JSON.parse(patch.specJson) : patch.specJson,
      updatedAt: patch.updatedAt ?? Date.now()
    })
    return
  }
  await requestMutation('db/plans-update', { id, workspaceId, patch })
}

export async function deletePlan(id: string, workspaceId = 'local-personal'): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.deletePlan({ id, workspaceId })
    return
  }
  await requestMutation('db/plans-delete', { id, workspaceId })
}
