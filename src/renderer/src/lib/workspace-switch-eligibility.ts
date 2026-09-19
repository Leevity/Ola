/**
 * Renderer-side stale-directory guard. Main and the runtime still perform the
 * authority check; this only prevents an already-revoked UI option from
 * requesting a switch first.
 */
export function canSwitchToKnownWorkspace(
  workspaceId: string,
  activeWorkspaceId: string,
  knownWorkspaceIds: Iterable<string>
): boolean {
  return workspaceId === activeWorkspaceId || [...knownWorkspaceIds].includes(workspaceId)
}

export function hasActiveSshWorkspaceActivity(state: {
  sessions: Record<string, { status: string }>
  sftpConnections: Record<string, { status: string }>
  uploadTasks: Record<string, { stage: string }>
  transferTasks: Record<string, { stage: string }>
}): boolean {
  return (
    Object.values(state.sessions).some((session) =>
      ['connecting', 'connected', 'reconnecting'].includes(session.status)
    ) ||
    Object.values(state.sftpConnections).some((connection) =>
      ['connecting', 'connected'].includes(connection.status)
    ) ||
    Object.values(state.uploadTasks).some((task) => ['upload', 'cleanup'].includes(task.stage)) ||
    Object.values(state.transferTasks).some((task) =>
      ['preparing', 'transferring', 'cleanup', 'paused'].includes(task.stage)
    )
  )
}
