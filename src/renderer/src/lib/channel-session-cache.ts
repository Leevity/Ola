export function isCurrentChannelSessionResponse(
  requestWorkspaceId: string,
  activeWorkspaceId: string
): boolean {
  return requestWorkspaceId === activeWorkspaceId
}
