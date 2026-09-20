import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

let repository: BusinessRepository | undefined
let root: string | undefined

afterEach(async () => {
  await repository?.close()
  if (root) await rm(root, { recursive: true, force: true })
  repository = undefined
  root = undefined
})

it('persists sub-agent history migration status in TS storage', async () => {
  root = await mkdtemp(join(tmpdir(), 'ola-sub-agent-history-migration-'))
  repository = new BusinessRepository({ path: join(root, 'data.db'), mode: 'direct' })

  await expect(repository.subAgentHistoryMigrationStatus('history-v1')).resolves.toMatchObject({
    applied: false
  })
  await expect(repository.markSubAgentHistoryMigration('history-v1', 123)).resolves.toBe(1)
  await expect(repository.subAgentHistoryMigrationStatus('history-v1')).resolves.toMatchObject({
    applied: true,
    appliedAt: 123
  })
})
