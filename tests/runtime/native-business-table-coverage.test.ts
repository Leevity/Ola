import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { LEGACY_BUSINESS_DATABASE_CONTRACT } from '../../src/runtime/storage/legacy-database-handover'

// These remain in Native backups but are not valid TS business handover domains.
// Keeping the list explicit makes a newly added Native table fail the inventory gate.
const retainedOutsideContract: Record<string, string> = {
  provider_health: 'Schema-only legacy health cache; active health registry is in Main memory.',
  provider_request_metrics: 'Schema-only legacy metrics; active usage lives in usage_events.',
  memory_automation_rollups: 'Unscoped v1 history retained; v2 is the workspace-owned source.',
  qq_wakeup_windows: 'Unscoped v1 history backfilled into qq_wakeup_windows_v2.',
  ssh_groups: 'Legacy Worker SSH database route retained for rollback; Main uses scoped JSON.',
  ssh_connections: 'Legacy Worker SSH database route retained for rollback; Main uses scoped JSON.',
  usage_activity_daily: 'Unscoped v1 usage aggregate retained; v2 is workspace-owned.',
  usage_activity_daily_models: 'Unscoped v1 model aggregate retained; v2 is workspace-owned.',
  usage_activity_daily_providers: 'Unscoped v1 provider aggregate retained; v2 is workspace-owned.',
  sync_record_state: 'Unscoped v1 sync baseline retained; TS v2 metadata is separate.',
  sync_tombstones: 'Unscoped v1 sync tombstones retained; TS v2 metadata is separate.'
}

it('accounts for every Native business table in the TS handover inventory', () => {
  const source = readFileSync('sidecars/Ola.Native.Worker/Modules/Db/DbSchemaMigrator.cs', 'utf8')
  const native = new Set(
    [...source.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/g)].map((match) => match[1])
  )
  const contracted = new Set(Object.keys(LEGACY_BUSINESS_DATABASE_CONTRACT))
  const retained = new Set(Object.keys(retainedOutsideContract))
  expect(native.size).toBe(48)
  expect(contracted.size).toBe(37)
  expect([...contracted].filter((table) => !native.has(table))).toEqual([])
  expect([...retained].filter((table) => !native.has(table) || contracted.has(table))).toEqual([])
  expect([...native].filter((table) => !contracted.has(table) && !retained.has(table))).toEqual([])
  expect(Object.values(retainedOutsideContract).every(Boolean)).toBe(true)
})
