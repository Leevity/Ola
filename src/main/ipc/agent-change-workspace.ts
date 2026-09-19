export async function assertAgentChangeWorkspace(
  workspaceId: unknown,
  sessionId: string | null | undefined,
  dependencies: {
    sessionWorkspace: (sessionId: string) => Promise<string | null>
    availableWorkspaceIds: () => Promise<ReadonlySet<string>>
  }
): Promise<string> {
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId !== workspaceId.trim())
    throw new Error('agent-change-workspace-required')
  if (
    workspaceId !== 'local-personal' &&
    !(await dependencies.availableWorkspaceIds()).has(workspaceId)
  )
    throw new Error('agent-change-workspace-unavailable')
  if (!sessionId) {
    if (workspaceId !== 'local-personal') throw new Error('agent-change-session-required')
    return workspaceId
  }
  if ((await dependencies.sessionWorkspace(sessionId)) !== workspaceId)
    throw new Error('agent-change-session-workspace-mismatch')
  return workspaceId
}

export async function assertAgentChangeSetWorkspace(
  workspaceId: unknown,
  sessionIds: Array<string | null | undefined>,
  dependencies: Parameters<typeof assertAgentChangeWorkspace>[2]
): Promise<string> {
  const uniqueSessionIds = [...new Set(sessionIds.filter((id): id is string => !!id))]
  if (uniqueSessionIds.length === 0)
    return assertAgentChangeWorkspace(workspaceId, null, dependencies)
  let authorizedWorkspace = ''
  for (const sessionId of uniqueSessionIds)
    authorizedWorkspace = await assertAgentChangeWorkspace(workspaceId, sessionId, dependencies)
  return authorizedWorkspace
}
