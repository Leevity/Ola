/** V1 WebDAV bundles have no workspace identity and may only serve local-personal data. */
export async function assertLegacySyncPersonalOnly(
  loadWorkspaceIds: () => Promise<Set<string>>
): Promise<void> {
  const workspaceIds = await loadWorkspaceIds()
  if ([...workspaceIds].some((id) => id !== 'local-personal')) {
    throw new Error('LEGACY_SYNC_TEAM_WORKSPACE_UNSUPPORTED')
  }
}
