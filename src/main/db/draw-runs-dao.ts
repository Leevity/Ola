import { getTsDatabaseRouteGuard } from './business-write-canary'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import { canaryListDrawRuns } from './legacy-read-canary'
import { businessWriteCanary } from './business-write-canary'

export interface DrawRunRow {
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

async function requireDrawWorkspace(workspaceId: string): Promise<string> {
  if (!workspaceId || workspaceId !== workspaceId.trim())
    throw new Error('Draw workspace is invalid')
  if (workspaceId !== 'local-personal' && !(await loadOfflineWorkspaceIds()).has(workspaceId))
    throw new Error('Draw workspace is not available')
  return workspaceId
}

interface DrawRunMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

function assertMutation(result: DrawRunMutationResult, operation: string): void {
  if (!result.success) {
    throw new Error(result.error || `Native draw run ${operation} failed`)
  }
}

export async function listDrawRuns(workspaceId: string): Promise<DrawRunRow[]> {
  const scopedWorkspaceId = await requireDrawWorkspace(workspaceId)
  const canary = await canaryListDrawRuns(scopedWorkspaceId)
  if (canary !== undefined) return canary
  const writer = businessWriteCanary()
  if (writer) return writer.drawRuns<DrawRunRow>(scopedWorkspaceId)
  return getTsDatabaseRouteGuard().request<DrawRunRow[]>(
    'db/draw-runs-list',
    { workspaceId: scopedWorkspaceId },
    120_000
  )
}

export async function saveDrawRun(run: {
  id: string
  workspaceId: string
  prompt: string
  providerName: string
  modelName: string
  mode?: string
  metaJson?: string | null
  createdAt: number
  isGenerating: boolean
  imagesJson: string
  errorJson?: string | null
  updatedAt: number
}): Promise<void> {
  const workspaceId = await requireDrawWorkspace(run.workspaceId)
  const writer = businessWriteCanary()
  if (writer) {
    await writer.saveDrawRun({
      id: run.id,
      workspaceId,
      prompt: run.prompt,
      providerName: run.providerName,
      modelName: run.modelName,
      mode: run.mode ?? 'image',
      metaJson: run.metaJson ?? null,
      createdAt: run.createdAt,
      isGenerating: run.isGenerating,
      imagesJson: run.imagesJson,
      errorJson: run.errorJson ?? null,
      updatedAt: run.updatedAt
    })
    return
  }
  const result = await getTsDatabaseRouteGuard().request<DrawRunMutationResult>(
    'db/draw-runs-save',
    { ...run, workspaceId },
    120_000
  )
  assertMutation(result, 'save')
}

export async function deleteDrawRun(id: string, workspaceId: string): Promise<void> {
  const scopedWorkspaceId = await requireDrawWorkspace(workspaceId)
  const writer = businessWriteCanary()
  if (writer) {
    await writer.deleteDrawRun(id, scopedWorkspaceId)
    return
  }
  const result = await getTsDatabaseRouteGuard().request<DrawRunMutationResult>(
    'db/draw-runs-delete',
    { id, workspaceId: scopedWorkspaceId },
    120_000
  )
  assertMutation(result, 'delete')
}

export async function clearDrawRuns(workspaceId: string): Promise<void> {
  const scopedWorkspaceId = await requireDrawWorkspace(workspaceId)
  const writer = businessWriteCanary()
  if (writer) {
    await writer.clearDrawRuns(scopedWorkspaceId)
    return
  }
  const result = await getTsDatabaseRouteGuard().request<DrawRunMutationResult>(
    'db/draw-runs-clear',
    { workspaceId: scopedWorkspaceId },
    120_000
  )
  assertMutation(result, 'clear')
}
