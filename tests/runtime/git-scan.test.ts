import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeGit } from '../../src/runtime/host/git-executor'
import { scanLocalGitRepositories } from '../../src/runtime/host/git-scan'

async function init(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  expect(await executeGit(directory, ['init'])).toMatchObject({ success: true })
}

describe('local Git repository scanner', () => {
  it('finds bounded nested repositories and does not enter excluded directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-git-scan-'))
    try {
      await init(join(root, 'packages', 'app'))
      await init(join(root, 'node_modules', 'ignored'))
      const repositories = await scanLocalGitRepositories({ rootPath: root, maxDepth: 3 })
      expect(repositories).toEqual([
        expect.objectContaining({
          fullPath: join(root, 'packages', 'app'),
          relativePath: 'packages/app',
          isRootRepo: false
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns the root repository without recursively reporting nested repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-git-root-scan-'))
    try {
      await init(root)
      await init(join(root, 'packages', 'app'))
      await expect(scanLocalGitRepositories({ rootPath: root, maxDepth: 3 })).resolves.toEqual([
        expect.objectContaining({ fullPath: root, relativePath: '.', isRootRepo: true })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
