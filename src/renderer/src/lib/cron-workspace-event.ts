export function isCronWorkspaceEventFor(data: unknown, workspaceId: string): boolean {
  return (
    data !== null &&
    typeof data === 'object' &&
    'workspaceId' in data &&
    data.workspaceId === workspaceId
  )
}
