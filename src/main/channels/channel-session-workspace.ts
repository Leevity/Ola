export async function authorizeChannelSessionWorkspace(
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
    throw new Error('CHANNEL_WORKSPACE_UNAVAILABLE')
  if (workspaceId !== 'local-personal' && !(await availableWorkspaceIds()).has(workspaceId))
    throw new Error('CHANNEL_WORKSPACE_UNAVAILABLE')
  return workspaceId
}

/** A directory grant can disappear while either the TS or Native read is in flight. */
export async function readAuthorizedChannelSession<T>(
  workspaceId: string,
  availableWorkspaceIds: () => Promise<ReadonlySet<string>>,
  read: () => Promise<T>
): Promise<T> {
  await authorizeChannelSessionWorkspace(workspaceId, availableWorkspaceIds)
  const result = await read()
  await authorizeChannelSessionWorkspace(workspaceId, availableWorkspaceIds)
  return result
}

/** Command work can outlive the directory grant checked when the message was routed. */
export async function runAuthorizedChannelCommand<T>(
  workspaceId: string,
  availableWorkspaceIds: () => Promise<ReadonlySet<string>>,
  run: () => Promise<T> | T
): Promise<T> {
  await authorizeChannelSessionWorkspace(workspaceId, availableWorkspaceIds)
  const result = await run()
  await authorizeChannelSessionWorkspace(workspaceId, availableWorkspaceIds)
  return result
}
