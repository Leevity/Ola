export async function resolveAuthorizedAgentRunWorkspace(
  sessionId: string,
  requestedWorkspaceId: string | null | undefined,
  dependencies: {
    sessionWorkspace: (sessionId: string) => Promise<string | null>
    availableWorkspaceIds: () => Promise<ReadonlySet<string>>
  }
): Promise<string> {
  const workspaceId = (await dependencies.sessionWorkspace(sessionId)) ?? 'local-personal'
  if (requestedWorkspaceId && requestedWorkspaceId !== workspaceId)
    throw new Error('SESSION_WORKSPACE_MISMATCH')
  if (
    workspaceId !== 'local-personal' &&
    !(await dependencies.availableWorkspaceIds()).has(workspaceId)
  )
    throw new Error('SSH_WORKSPACE_UNAVAILABLE')
  return workspaceId
}
