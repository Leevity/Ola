import { getNativeWorker } from '../lib/native-worker'
import { canaryGetSession, canaryListSessions } from './legacy-read-canary'
import { businessWriteCanary } from './business-write-canary'

export interface SessionRow {
  id: string
  title: string
  icon: string | null
  mode: string
  created_at: number
  updated_at: number
  project_id: string | null
  working_folder: string | null
  ssh_connection_id: string | null
  plan_id: string | null
  pinned: number
  plugin_id: string | null
  external_chat_id?: string | null
  provider_id: string | null
  model_id: string | null
  model_selection_mode: string | null
  /** Serialized public ModelSource; credentials are never stored here. */
  model_source?: string | null
  task_profile?: string | null
  task_profile_locked?: number
  workspace_id: string
  message_count?: number
}

interface SessionFindResult {
  success: boolean
  session?: SessionRow | null
  error?: string | null
}

interface SessionMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

interface SessionClearAllResult {
  success: boolean
  sessionIds: string[]
  deletedMessages: number
  deletedSessions: number
  error?: string | null
}

async function requestMutation(method: string, params: object): Promise<SessionMutationResult> {
  const result = await getNativeWorker().request<SessionMutationResult>(method, params, 120_000)
  if (!result.success) {
    throw new Error(result.error || `Native session mutation failed: ${method}`)
  }
  return result
}

export async function listSessions(
  limit = 2000,
  offset = 0,
  workspaceId?: string
): Promise<SessionRow[]> {
  const migrated = await canaryListSessions({ workspaceId, limit, offset })
  if (migrated) return migrated
  return getNativeWorker().request<SessionRow[]>(
    'db/sessions-list',
    { limit, offset, workspaceId },
    120_000
  )
}

export async function getSession(
  id: string,
  workspaceId?: string
): Promise<SessionRow | undefined> {
  const migrated = await canaryGetSession({ id, workspaceId })
  if (migrated !== undefined) return migrated ?? undefined
  const result = await getNativeWorker().request<SessionFindResult>(
    'db/sessions-get',
    { id, workspaceId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native session get failed')
  }
  return result.session ?? undefined
}

export async function createSession(session: {
  id: string
  title: string
  icon?: string
  mode: string
  createdAt: number
  updatedAt: number
  projectId?: string | null
  workingFolder?: string
  sshConnectionId?: string
  planId?: string | null
  pinned?: boolean
  pluginId?: string
  providerId?: string
  modelId?: string
  modelSelectionMode?: string
  modelSource?: string
  workspaceId?: string
}): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!session.workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.createSession<SessionRow>({
      id: session.id,
      title: session.title,
      mode: session.mode,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      workspaceId: session.workspaceId,
      icon: session.icon ?? null,
      projectId: session.projectId ?? null,
      workingFolder: session.workingFolder ?? null,
      sshConnectionId: session.sshConnectionId ?? null,
      planId: session.planId ?? null,
      pinned: session.pinned ?? false,
      pluginId: session.pluginId ?? null,
      providerId: session.providerId ?? null,
      modelId: session.modelId ?? null,
      modelSelectionMode: session.modelSelectionMode ?? null,
      modelSource: session.modelSource ?? null
    })
    return
  }
  await requestMutation('db/sessions-create', session)
}

export async function updateSession(
  id: string,
  workspaceId: string | undefined,
  patch: Partial<{
    title: string
    icon: string | null
    mode: string
    updatedAt: number
    projectId: string | null
    workingFolder: string | null
    sshConnectionId: string | null
    planId: string | null
    pinned: boolean
    pluginId: string | null
    providerId: string | null
    modelId: string | null
    modelSelectionMode: string | null
    modelSource: string | null
    workspaceId: string | null
  }>
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.updateSession<SessionRow>({
      id,
      ...patch,
      workspaceId,
      updatedAt: patch.updatedAt ?? Date.now()
    })
    return
  }
  await requestMutation('db/sessions-update', { id, workspaceId, patch })
}

export async function deleteSession(id: string, workspaceId?: string): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    await writer.deleteSession({ id, workspaceId })
    return
  }
  await requestMutation('db/sessions-delete', { id, workspaceId })
}

export async function clearAllSessions(workspaceId: string): Promise<SessionClearAllResult> {
  const writer = businessWriteCanary()
  if (writer) return writer.clearAllSessions(workspaceId)
  const result = await getNativeWorker().request<SessionClearAllResult>(
    'db/sessions-clear-all',
    { workspaceId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native session clear-all failed')
  }
  return result
}
