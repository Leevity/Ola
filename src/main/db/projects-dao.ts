import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'node:crypto'
import { getTsDatabaseRouteGuard } from './business-write-canary'
import { olaDataRoot } from '../lib/ola-data-root'
import { readSettings } from '../ipc/settings-handlers'
import {
  canaryFindProjectByPlugin,
  canaryGetProject,
  canaryListProjects
} from './legacy-read-canary'
import { businessWriteCanary } from './business-write-canary'

export interface ProjectRow {
  id: string
  name: string
  working_folder: string | null
  ssh_connection_id: string | null
  plugin_id: string | null
  pinned: number
  created_at: number
  updated_at: number
  workspace_id: string
  model_source?: string | null
}

interface ProjectFindResult {
  success: boolean
  project?: ProjectRow | null
  error?: string | null
}

export interface ProjectDeleteResult {
  success: boolean
  deleted: boolean
  projectId?: string | null
  sessionIds: string[]
  error?: string | null
}

function getPreferredLocalProjectBaseDirectory(): string {
  // A desktop E2E run must never reuse a saved Documents/custom directory from real settings.
  if (process.env.OLA_E2E_DATA_ROOT !== undefined) return path.join(olaDataRoot(), 'projects')
  const settings = readSettings()
  const mode = settings.projectDefaultDirectoryMode
  const customDir =
    typeof settings.projectDefaultDirectory === 'string'
      ? settings.projectDefaultDirectory.trim()
      : ''
  const lastUsedDir =
    typeof settings.lastProjectDirectory === 'string' ? settings.lastProjectDirectory.trim() : ''

  if (mode === 'custom' && customDir) {
    return customDir
  }
  if (lastUsedDir) {
    return lastUsedDir
  }
  return path.join(os.homedir(), 'Documents')
}

function withProjectBaseDirectory<T extends object>(params: T): T & { baseDirectory: string } {
  return {
    ...params,
    baseDirectory: getPreferredLocalProjectBaseDirectory()
  }
}

export async function listProjects(workspaceId = 'local-personal'): Promise<ProjectRow[]> {
  const writer = businessWriteCanary()
  if (writer) return await writer.projects<ProjectRow>(workspaceId)
  const migrated = await canaryListProjects(workspaceId)
  if (migrated !== undefined) return migrated
  return getTsDatabaseRouteGuard().request<ProjectRow[]>(
    'db/projects-list',
    { workspaceId },
    120_000
  )
}

export async function getProject(
  id: string,
  workspaceId = 'local-personal'
): Promise<ProjectRow | undefined> {
  const writer = businessWriteCanary()
  if (writer) return (await writer.project<ProjectRow>(id, workspaceId)) ?? undefined
  const migrated = await canaryGetProject(id, workspaceId)
  if (migrated !== undefined) return migrated ?? undefined
  const result = await getTsDatabaseRouteGuard().request<ProjectFindResult>(
    'db/projects-get',
    { id, workspaceId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native project get failed')
  }
  return result.project ?? undefined
}

export async function findProjectByPluginId(
  pluginId: string,
  workspaceId = 'local-personal'
): Promise<ProjectRow | undefined> {
  const writer = businessWriteCanary()
  if (writer) return (await writer.projectByPlugin<ProjectRow>(pluginId, workspaceId)) ?? undefined
  const migrated = await canaryFindProjectByPlugin(pluginId, workspaceId)
  if (migrated !== undefined) return migrated ?? undefined
  const result = await getTsDatabaseRouteGuard().request<ProjectFindResult>(
    'db/projects-find-by-plugin',
    { pluginId, workspaceId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native project plugin lookup failed')
  }
  return result.project ?? undefined
}

export async function createProject(project: {
  id?: string
  name: string
  workingFolder?: string | null
  sshConnectionId?: string | null
  pluginId?: string | null
  pinned?: boolean
  createdAt?: number
  updatedAt?: number
  workspaceId?: string
  /** Public binding only; local secrets remain in the Main secret store. */
  modelSource?: string | null
}): Promise<ProjectRow> {
  const writer = businessWriteCanary()
  if (writer) {
    const workspaceId = project.workspaceId
    if (!workspaceId) throw new Error('TS_BUSINESS_WORKSPACE_REQUIRED')
    return writer.createProject<ProjectRow>({
      id: project.id ?? `oc_${randomUUID().replaceAll('-', '')}`,
      name: project.name,
      workspaceId,
      createdAt: project.createdAt ?? Date.now(),
      updatedAt: project.updatedAt ?? Date.now(),
      workingFolder: project.workingFolder ?? null,
      sshConnectionId: project.sshConnectionId ?? null,
      pluginId: project.pluginId ?? null,
      pinned: project.pinned ?? false,
      modelSource: project.modelSource ?? null
    })
  }
  return getTsDatabaseRouteGuard().request<ProjectRow>(
    'db/projects-create',
    withProjectBaseDirectory(project),
    120_000
  )
}

export async function updateProject(
  id: string,
  workspaceId: string,
  patch: Partial<{
    name: string
    workingFolder: string | null
    sshConnectionId: string | null
    pluginId: string | null
    pinned: boolean
    updatedAt: number
    workspaceId: string | null
    modelSource: string | null
  }>
): Promise<void> {
  const writer = businessWriteCanary()
  if (writer) {
    await writer.updateProject<ProjectRow>({
      id,
      ...patch,
      workspaceId,
      updatedAt: patch.updatedAt ?? Date.now()
    })
    return
  }
  const result = await getTsDatabaseRouteGuard().request<ProjectFindResult>(
    'db/projects-update',
    withProjectBaseDirectory({ id, workspaceId, patch }),
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native project update failed')
  }
}

export async function deleteProject(
  id: string,
  workspaceId: string
): Promise<ProjectDeleteResult | null> {
  const writer = businessWriteCanary()
  if (writer) {
    const deleted = await writer.deleteProject({ id, workspaceId })
    return deleted ? { success: true, deleted: true, projectId: id, sessionIds: [] } : null
  }
  const result = await getTsDatabaseRouteGuard().request<ProjectDeleteResult>(
    'db/projects-delete',
    { id, workspaceId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native project delete failed')
  }
  return result.deleted ? result : null
}

export async function ensureDefaultProject(
  workspaceId = 'local-personal',
  preferredName?: string
): Promise<ProjectRow> {
  const writer = businessWriteCanary()
  if (writer) {
    return writer.ensureDefaultProject<ProjectRow>({
      workspaceId,
      preferredName,
      baseDirectory: getPreferredLocalProjectBaseDirectory()
    })
  }
  return getTsDatabaseRouteGuard().request<ProjectRow>(
    'db/projects-ensure-default',
    withProjectBaseDirectory({ workspaceId, preferredName }),
    120_000
  )
}

export async function ensurePluginProject(
  pluginId: string,
  preferredName?: string,
  workspaceId = 'local-personal'
): Promise<ProjectRow> {
  const writer = businessWriteCanary()
  if (writer) {
    return writer.ensurePluginProject<ProjectRow>({
      pluginId,
      preferredName,
      workspaceId,
      baseDirectory: getPreferredLocalProjectBaseDirectory()
    })
  }
  return getTsDatabaseRouteGuard().request<ProjectRow>(
    'db/projects-ensure-plugin',
    withProjectBaseDirectory({ pluginId, preferredName, workspaceId }),
    120_000
  )
}
