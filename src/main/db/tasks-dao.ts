import { getTsDatabaseRouteGuard } from './business-write-canary'
import { canaryGetTask, canaryListTasks, canaryListTasksBySession } from './legacy-read-canary'
import { businessWriteCanary } from './business-write-canary'

export interface TaskRow {
  id: string
  session_id: string
  plan_id: string | null
  subject: string
  description: string
  active_form: string | null
  status: string
  owner: string | null
  blocks: string
  blocked_by: string
  metadata: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

interface TaskFindResult {
  success: boolean
  task?: TaskRow | null
  error?: string | null
}

interface TaskMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

async function requestMutation(method: string, params: object): Promise<TaskMutationResult> {
  const result = await getTsDatabaseRouteGuard().request<TaskMutationResult>(
    method,
    params,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || `Native task mutation failed: ${method}`)
  }
  return result
}

export async function listTasksBySession(
  sessionId: string,
  workspaceId = 'local-personal'
): Promise<TaskRow[]> {
  const writer = businessWriteCanary()
  if (writer) return await writer.tasksBySession<TaskRow>(sessionId, workspaceId)
  const migrated = await canaryListTasksBySession(sessionId, workspaceId)
  if (migrated !== undefined) return migrated
  return getTsDatabaseRouteGuard().request<TaskRow[]>(
    'db/tasks-list-by-session',
    { sessionId, workspaceId },
    120_000
  )
}

export async function listAllTasks(workspaceId = 'local-personal'): Promise<TaskRow[]> {
  const writer = businessWriteCanary()
  if (writer) return await writer.tasks<TaskRow>(workspaceId)
  const migrated = await canaryListTasks(workspaceId)
  if (migrated !== undefined) return migrated
  return getTsDatabaseRouteGuard().request<TaskRow[]>('db/tasks-list-all', { workspaceId }, 120_000)
}

export async function getTask(
  id: string,
  workspaceId = 'local-personal'
): Promise<TaskRow | undefined> {
  const writer = businessWriteCanary()
  if (writer) return (await writer.task<TaskRow>(id, workspaceId)) ?? undefined
  const migrated = await canaryGetTask(id, workspaceId)
  if (migrated !== undefined) return migrated ?? undefined
  const result = await getTsDatabaseRouteGuard().request<TaskFindResult>(
    'db/tasks-get',
    { id, workspaceId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native task get failed')
  }
  return result.task ?? undefined
}

export async function createTask(task: {
  id: string
  sessionId: string
  workspaceId: string
  planId?: string
  subject: string
  description: string
  activeForm?: string
  status?: string
  owner?: string
  blocks?: string[]
  blockedBy?: string[]
  metadata?: Record<string, unknown>
  sortOrder: number
  createdAt: number
  updatedAt: number
}): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.createTask({
      ...task,
      planId: task.planId ?? null,
      activeForm: task.activeForm ?? null,
      owner: task.owner ?? null,
      blocks: task.blocks ?? [],
      blockedBy: task.blockedBy ?? [],
      metadata: task.metadata ?? null
    })
    return
  }
  await requestMutation('db/tasks-create', task)
}

export async function updateTask(
  id: string,
  workspaceId: string,
  patch: Partial<{
    subject: string
    description: string
    activeForm: string | null
    status: string
    owner: string | null
    blocks: string[]
    blockedBy: string[]
    metadata: Record<string, unknown> | null
    sortOrder: number
    updatedAt: number
  }>,
  expectedUpdatedAt?: number
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.updateTask({
      id,
      workspaceId,
      expectedUpdatedAt,
      ...patch,
      updatedAt: patch.updatedAt ?? Date.now()
    })
    return
  }
  if (expectedUpdatedAt !== undefined) throw new Error('BUSINESS_TASK_VERSION_UNAVAILABLE')
  await requestMutation('db/tasks-update', { id, workspaceId, patch, expectedUpdatedAt })
}

export async function deleteTask(
  id: string,
  workspaceId: string,
  expectedUpdatedAt?: number
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.deleteTask({ id, workspaceId, expectedUpdatedAt })
    return
  }
  if (expectedUpdatedAt !== undefined) throw new Error('BUSINESS_TASK_VERSION_UNAVAILABLE')
  await requestMutation('db/tasks-delete', { id, workspaceId, expectedUpdatedAt })
}

export async function deleteTasksBySession(sessionId: string, workspaceId: string): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.deleteTasksBySession({ sessionId, workspaceId })
    return
  }
  await requestMutation('db/tasks-delete-by-session', { sessionId, workspaceId })
}
