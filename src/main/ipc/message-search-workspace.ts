export async function authorizeMessageSearchWorkspace(
  rawWorkspaceId: unknown,
  availableWorkspaceIds: () => Promise<ReadonlySet<string>>
): Promise<string> {
  if (
    typeof rawWorkspaceId !== 'string' ||
    !rawWorkspaceId ||
    rawWorkspaceId !== rawWorkspaceId.trim() ||
    rawWorkspaceId.length > 1024
  )
    throw new Error('message-search-workspace-required')
  if (rawWorkspaceId !== 'local-personal' && !(await availableWorkspaceIds()).has(rawWorkspaceId))
    throw new Error('message-search-workspace-unavailable')
  return rawWorkspaceId
}
