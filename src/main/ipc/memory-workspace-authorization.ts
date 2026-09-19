import { authorizeDbWorkspace } from './db-workspace-authorization'

export async function authorizeMemoryWorkspace(
  args: unknown,
  registeredWorkspaceId: string | null,
  availableWorkspaceIds: () => Promise<ReadonlySet<string>>
): Promise<string> {
  const requested =
    args && typeof args === 'object' && 'workspaceId' in args ? args.workspaceId : undefined
  const workspaceId = await authorizeDbWorkspace(
    requested === undefined ? 'local-personal' : requested,
    availableWorkspaceIds
  )
  if (registeredWorkspaceId !== workspaceId) throw new Error('MEMORY_WINDOW_WORKSPACE_MISMATCH')
  return workspaceId
}

export async function handleMemoryWorkspaceRequest<T>(
  args: unknown,
  registeredWorkspaceId: () => string | null,
  availableWorkspaceIds: () => Promise<ReadonlySet<string>>,
  handler: () => Promise<T> | T
): Promise<T> {
  const workspaceId = await authorizeMemoryWorkspace(
    args,
    registeredWorkspaceId(),
    availableWorkspaceIds
  )
  const result = await handler()
  await authorizeMemoryWorkspace({ workspaceId }, registeredWorkspaceId(), availableWorkspaceIds)
  return result
}
