import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeGit } from '../../src/runtime/host/git-executor'
import { queryLocalGit } from '../../src/runtime/host/git-query'

describe('queryLocalGit', () => {
  it('matches the read-only desktop Git query contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-git-query-'))
    try {
      await executeGit(root, ['init'])
      await executeGit(root, ['config', 'user.email', 'test@example.com'])
      await executeGit(root, ['config', 'user.name', 'Test'])
      await writeFile(join(root, 'note.txt'), 'first\n', 'utf8')
      await executeGit(root, ['add', 'note.txt'])
      await executeGit(root, ['commit', '-m', 'initial'])
      const first = (await queryLocalGit(root, 'get-head')).commitId as string
      await writeFile(join(root, 'note.txt'), 'second\n', 'utf8')
      await executeGit(root, ['add', 'note.txt'])

      await expect(queryLocalGit(root, 'get-line-summary')).resolves.toMatchObject({
        success: true,
        added: 1,
        deleted: 1,
        binary: 0
      })
      await expect(
        queryLocalGit(root, 'get-staged-diff-bundle', { maxPatchChars: 10 })
      ).resolves.toMatchObject({
        success: true,
        empty: false,
        stat: expect.stringContaining('note.txt'),
        patch: expect.stringContaining('patch truncated')
      })
      await executeGit(root, ['commit', '-m', 'second'])

      await expect(queryLocalGit(root, 'get-head')).resolves.toMatchObject({
        success: true,
        commitId: expect.stringMatching(/^[0-9a-f]{40}$/)
      })
      await expect(queryLocalGit(root, 'get-changed-files', `${first}..HEAD`)).resolves.toEqual({
        success: true,
        files: ['note.txt']
      })
      await expect(
        queryLocalGit(root, 'get-range-commits', `${first}..HEAD`)
      ).resolves.toMatchObject({
        success: true,
        commits: [expect.stringMatching(/^[0-9a-f]{40}$/)]
      })
      await expect(
        queryLocalGit(root, 'get-file-content-at-ref', 'HEAD:note.txt')
      ).resolves.toMatchObject({
        success: true,
        content: 'second\n',
        exists: true
      })
      await expect(
        queryLocalGit(root, 'get-file-content-at-ref', 'HEAD:missing.txt')
      ).resolves.toMatchObject({
        success: true,
        content: '',
        exists: false
      })
      await expect(
        queryLocalGit(root, 'get-file-content-at-ref', 'HEAD:../secret')
      ).resolves.toMatchObject({
        success: false,
        errorType: 'VALIDATION'
      })
      await expect(
        queryLocalGit(root, 'get-file-diff-at-commit', { filePath: 'note.txt', commitHash: 'HEAD' })
      ).resolves.toMatchObject({
        success: true,
        diff: expect.stringContaining('-first')
      })
      await expect(queryLocalGit(root, 'get-commit-history', { limit: 1 })).resolves.toMatchObject({
        success: true,
        history: [expect.objectContaining({ subject: 'second' })]
      })
      await expect(
        queryLocalGit(root, 'get-file-history', { filePath: 'note.txt', limit: 1 })
      ).resolves.toMatchObject({
        success: true,
        history: [expect.objectContaining({ subject: 'second' })]
      })
      await expect(queryLocalGit(root, 'list-branches')).resolves.toMatchObject({
        success: true,
        current: expect.any(String),
        branches: [expect.objectContaining({ type: 'local', isCurrent: true })]
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
