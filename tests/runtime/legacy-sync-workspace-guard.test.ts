import { expect, it } from 'vitest'
import { assertLegacySyncPersonalOnly } from '../../src/main/sync/legacy-sync-workspace-guard'

it('allows legacy WebDAV only without a managed workspace directory', async () => {
  await expect(assertLegacySyncPersonalOnly(async () => new Set())).resolves.toBeUndefined()
  await expect(
    assertLegacySyncPersonalOnly(async () => new Set(['local-personal']))
  ).resolves.toBeUndefined()
})

it('rejects active managed personal and team spaces before legacy sync runs', async () => {
  await expect(
    assertLegacySyncPersonalOnly(async () => new Set(['local-personal', 'team-a']))
  ).rejects.toThrow('LEGACY_SYNC_TEAM_WORKSPACE_UNSUPPORTED')
  await expect(
    assertLegacySyncPersonalOnly(async () => new Set(['managed-personal']))
  ).rejects.toThrow('LEGACY_SYNC_TEAM_WORKSPACE_UNSUPPORTED')
})
