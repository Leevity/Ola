export async function authorizeDbWorkspace(
  rawWorkspaceId: unknown,
  availableWorkspaceIds: () => Promise<ReadonlySet<string>>,
  registeredWorkspaceId?: string | null
): Promise<string> {
  if (
    typeof rawWorkspaceId !== 'string' ||
    !rawWorkspaceId ||
    rawWorkspaceId !== rawWorkspaceId.trim() ||
    rawWorkspaceId.length > 1024
  )
    throw new Error('db-workspace-required')
  if (registeredWorkspaceId !== undefined && registeredWorkspaceId !== rawWorkspaceId)
    throw new Error('db-workspace-window-mismatch')
  if (rawWorkspaceId !== 'local-personal' && !(await availableWorkspaceIds()).has(rawWorkspaceId))
    throw new Error('db-workspace-unavailable')
  return rawWorkspaceId
}
