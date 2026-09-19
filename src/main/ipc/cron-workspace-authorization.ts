import { authorizeDbWorkspace } from './db-workspace-authorization'

export async function authorizeCronWorkspace(
  args: unknown,
  registeredWorkspaceId: string | null,
  availableWorkspaceIds: () => Promise<ReadonlySet<string>>
): Promise<string> {
  const rawWorkspaceId =
    args && typeof args === 'object' && 'workspaceId' in args ? args.workspaceId : undefined
  const workspaceId = await authorizeDbWorkspace(rawWorkspaceId, availableWorkspaceIds)
  if (registeredWorkspaceId !== workspaceId) throw new Error('cron-workspace-mismatch')
  return workspaceId
}
