/** Connection IDs are only unique inside their workspace. */
export function sshSessionsForConnection<T extends { connectionId: string; workspaceId: string }>(
  sessions: ReadonlyMap<string, T>,
  connectionId: string,
  workspaceId: string
): Array<[string, T]> {
  return [...sessions].filter(
    ([, session]) => session.connectionId === connectionId && session.workspaceId === workspaceId
  )
}
