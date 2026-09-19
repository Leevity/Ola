import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  reads: [] as Array<{ projectRoot: string; workspaceId: string }>,
  fail: false,
  closed: 0
}))

vi.mock('../../src/main/db/database', () => ({ getDataDir: () => '/unused' }))
vi.mock('../../src/runtime/storage/legacy-read-repository', () => ({
  LegacyReadRepository: class {
    async wikiDocument(projectRoot: string, workspaceId: string) {
      state.reads.push({ projectRoot, workspaceId })
      if (state.fail) throw new Error('read failed')
      return { id: 'wiki-a', projectRoot, generatedAt: 1, fileCount: 0, nodes: [] }
    }
    async close() {
      state.closed++
    }
  }
}))

import { canaryGetWikiDocument } from '../../src/main/db/legacy-read-canary'

afterEach(() => {
  delete process.env.OLA_TS_WIKI_READS
  delete process.env.OLA_TS_LEGACY_READ_PATH
  state.fail = false
  state.reads = []
})

it('uses the default TS Wiki reader and falls back after a read failure', async () => {
  process.env.OLA_TS_LEGACY_READ_PATH = '/unused/native.db'
  await expect(canaryGetWikiDocument('/project', 'team-a')).resolves.toMatchObject({
    id: 'wiki-a'
  })
  expect(state.reads).toEqual([{ projectRoot: '/project', workspaceId: 'team-a' }])
  process.env.OLA_TS_WIKI_READS = '0'
  await expect(canaryGetWikiDocument('/project', 'team-a')).resolves.toBeUndefined()
  expect(state.reads).toHaveLength(1)
  delete process.env.OLA_TS_WIKI_READS
  state.fail = true
  await expect(canaryGetWikiDocument('/project', 'team-a')).resolves.toBeUndefined()
  expect(state.closed).toBe(1)
})
