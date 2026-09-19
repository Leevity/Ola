export async function authorizeSshWorkspace(
  rawWorkspaceId: unknown,
  availableWorkspaceIds: () => Promise<ReadonlySet<string>>
): Promise<string> {
  const workspaceId = rawWorkspaceId === undefined ? 'local-personal' : rawWorkspaceId
  if (
    typeof workspaceId !== 'string' ||
    !workspaceId ||
    workspaceId !== workspaceId.trim() ||
    workspaceId.length > 1024
  )
    throw new Error('SSH_WORKSPACE_UNAVAILABLE')
  if (workspaceId !== 'local-personal' && !(await availableWorkspaceIds()).has(workspaceId))
    throw new Error('SSH_WORKSPACE_UNAVAILABLE')
  return workspaceId
}
