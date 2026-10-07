import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { LATEST_BUSINESS_SCHEMA_VERSION } from '../../src/runtime/storage/business-schema.mjs'

it('accounts for the TS-owned business schema and versioned migration entrypoint', () => {
  const source = readFileSync('src/runtime/storage/business-schema.mjs', 'utf8')
  expect(LATEST_BUSINESS_SCHEMA_VERSION).toBeGreaterThanOrEqual(8)
  for (const table of ['sessions', 'messages', 'projects', 'plans', 'cron_jobs', 'runtime_jobs']) {
    expect(source).toContain(`${table}:`)
  }
  expect(source).toContain('CREATE TABLE IF NOT EXISTS ola_pending_session_queues')
  expect(source).toContain('export function migrateBusinessSchema')
})
