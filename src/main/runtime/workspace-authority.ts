import { LOCAL_PERSONAL_WORKSPACE_ID } from '../../shared/runtime/model-source'

/**
 * The workspaces the runtime host may serve.
 *
 * `local-personal` is always permitted. The hosted ids come from the account directory, and a
 * directory that cannot be read — an expired token, an unreachable main site, a rejected
 * certificate — says nothing about the local workspace, so it must not take it down: every runtime
 * request is authorized against this set, and letting the read fail here failed local chat with a
 * locally configured provider as well. Hosted runs stay forbidden in that state, because the ids
 * that were withheld are exactly the ones that could not be verified.
 *
 * The same rule the Cron scope query already applies (`src/main/db/cron-dao.ts`).
 */
export async function permittedWorkspaceIds(
  loadDirectoryIds: () => Promise<Iterable<string>>
): Promise<Set<string>> {
  const ids = new Set<string>([LOCAL_PERSONAL_WORKSPACE_ID])
  try {
    for (const id of await loadDirectoryIds()) ids.add(id)
  } catch (error) {
    console.warn('[TsRuntime] workspace directory unavailable; serving the local workspace only', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
  return ids
}
