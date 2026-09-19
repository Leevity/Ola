export async function revokeUnavailableWorkspaceResources<T extends { workspaceId: string }>(
  resources: Map<string, T>,
  availableIds: ReadonlySet<string>,
  stop: (resource: T, id: string) => Promise<void> | void
): Promise<void> {
  const revoked = [...resources].filter(
    ([, resource]) =>
      resource.workspaceId !== 'local-personal' && !availableIds.has(resource.workspaceId)
  )
  const results = await Promise.allSettled(
    revoked.map(([id, resource]) => Promise.resolve().then(() => stop(resource, id)))
  )
  for (const [index, result] of results.entries()) {
    const [id, resource] = revoked[index]
    if (result.status === 'rejected') {
      console.warn('[SSH] Failed to revoke workspace resource:', result.reason)
      continue
    }
    if (resources.get(id) === resource) resources.delete(id)
  }
}
