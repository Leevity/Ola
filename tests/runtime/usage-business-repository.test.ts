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

it('owns usage event writes, aggregations, and maintenance in TS storage', async () => {
  root = await mkdtemp(join(tmpdir(), 'ola-usage-ts-'))
  repository = new BusinessRepository({ path: join(root, 'data.db'), mode: 'direct' })

  await repository.addUsageEvent({
    id: 'usage-a',
    workspace_id: 'team-a',
    created_at: 100,
    source_kind: 'chat',
    provider_id: 'provider-a',
    model_id: 'model-a',
    input_tokens: 10,
    output_tokens: 4
  })
  await repository.addUsageEvent({
    id: 'usage-old',
    workspace_id: 'team-a',
    created_at: 10,
    source_kind: 'chat',
    input_tokens: 1,
    output_tokens: 1
  })

  await expect(
    repository.usageEvents({ workspaceId: 'team-a', from: 0, to: 2000 })
  ).resolves.toEqual([
    expect.objectContaining({ id: 'usage-a' }),
    expect.objectContaining({ id: 'usage-old' })
  ])
  await expect(
    repository.queryRawUsage('overview', { workspaceId: 'team-a', from: 0, to: 2000 })
  ).resolves.toMatchObject({
    row: expect.objectContaining({ input_tokens: 11, output_tokens: 5 })
  })
  await expect(repository.maintainUsage(50)).resolves.toMatchObject({ cutoff: 50, deleted: 1 })
  await expect(
    repository.usageEvents({ workspaceId: 'team-a', from: 0, to: 2000 })
  ).resolves.toHaveLength(1)
})
