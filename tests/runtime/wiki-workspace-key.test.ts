import { expect, it, vi } from 'vitest'
import { wikiWorkspaceStorageKey } from '../../src/main/wiki/wiki-workspace-key'

const requests = vi.hoisted(() => [] as Array<{ method: string; params: Record<string, unknown> }>)

vi.mock('../../src/main/lib/native-worker', () => ({
  getNativeWorker: () => ({
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      if (method === 'db/wiki-get') return null
      return { success: true, changed: 1 }
    }
  })
}))
vi.mock('../../src/main/db/legacy-read-canary', () => ({
  canaryGetWikiDocument: async () => undefined
}))

import {
  deleteWikiDocument,
  loadWikiDocument,
  saveWikiDocument
} from '../../src/main/db/capability-dao'

it('keeps legacy personal Wiki keys while separating the same root across workspaces', () => {
  const root = '/projects/shared'
  expect(wikiWorkspaceStorageKey(root, 'local-personal')).toBe(root)
  expect(wikiWorkspaceStorageKey(root, 'team-a')).not.toBe(root)
  expect(wikiWorkspaceStorageKey(root, 'team-a')).not.toBe(wikiWorkspaceStorageKey(root, 'team-b'))
  expect(wikiWorkspaceStorageKey(root, 'team-a')).not.toBe(
    wikiWorkspaceStorageKey('/projects/other', 'team-a')
  )
})

it('uses the scoped key for Native Wiki reads, writes and deletes', async () => {
  requests.length = 0
  const projectRoot = '/projects/shared'
  const workspaceId = 'team-a'
  await loadWikiDocument(projectRoot, workspaceId)
  await saveWikiDocument(
    { id: 'wiki-a', projectRoot, generatedAt: 1, fileCount: 0, nodes: [] },
    workspaceId
  )
  await deleteWikiDocument(projectRoot, workspaceId)
  expect(requests.map((item) => item.method)).toEqual([
    'db/wiki-get',
    'db/wiki-save',
    'db/wiki-delete'
  ])
  expect(requests.map((item) => item.params.projectRoot)).toEqual(
    Array(3).fill(wikiWorkspaceStorageKey(projectRoot, workspaceId))
  )
})
