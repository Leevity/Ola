import { authorizeDbWorkspace } from './db-workspace-authorization'

export async function authorizeGeneratedImageWorkspace(
  requestedWorkspaceId: unknown,
  registeredWorkspaceId: string | null,
  availableWorkspaceIds: () => Promise<ReadonlySet<string>>
): Promise<string> {
  const workspaceId = await authorizeDbWorkspace(requestedWorkspaceId, availableWorkspaceIds)
  if (workspaceId !== registeredWorkspaceId)
    throw new Error('GENERATED_IMAGE_WINDOW_WORKSPACE_MISMATCH')
  return workspaceId
}
