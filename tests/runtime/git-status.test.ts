import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeGit } from '../../src/runtime/host/git-executor'
import {
  getLocalGitStatusDetailed,
  parseLocalGitStatusDetailed
} from '../../src/runtime/host/git-status'

describe('local Git detailed status', () => {
  it('parses branch tracking and porcelain file buckets', () => {
    expect(
      parseLocalGitStatusDetailed(
        '## feature...origin/feature [ahead 2, behind 1]\nM  staged.txt\n M changed.txt\n?? new.txt\nUU conflict.txt\n'
      )
    ).toEqual({
      branch: 'feature',
      upstream: 'origin/feature',
      ahead: 2,
      behind: 1,
      staged: [{ path: 'staged.txt', stagedStatus: 'M', unstagedStatus: ' ' }],
      unstaged: [{ path: 'changed.txt', stagedStatus: ' ', unstagedStatus: 'M' }],
      untracked: [{ path: 'new.txt', stagedStatus: '?', unstagedStatus: '?' }],
      conflicted: [{ path: 'conflict.txt', stagedStatus: 'U', unstagedStatus: 'U' }]
    })
  })

  it('reads actual repository state through the TS host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-git-status-'))
    try {
      await executeGit(root, ['init'])
      await executeGit(root, ['config', 'user.email', 'test@example.com'])
      await executeGit(root, ['config', 'user.name', 'Test'])
      await writeFile(join(root, 'staged.txt'), 'staged\n')
      await executeGit(root, ['add', 'staged.txt'])
      await writeFile(join(root, 'new.txt'), 'new\n')
      await expect(getLocalGitStatusDetailed(root)).resolves.toMatchObject({
        success: true,
        status: {
          staged: [expect.objectContaining({ path: 'staged.txt' })],
          untracked: [expect.objectContaining({ path: 'new.txt' })]
        }
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
