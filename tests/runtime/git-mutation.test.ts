import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeGit } from '../../src/runtime/host/git-executor'
import {
  executeLocalGitMutation,
  requireSafeGitPaths,
  requireSafeGitReference
} from '../../src/runtime/host/git-mutation'

describe('local Git mutation host', () => {
  it('executes a bounded local commit through the TS host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-git-mutation-'))
    try {
      await executeGit(root, ['init'])
      await executeGit(root, ['config', 'user.email', 'test@example.com'])
      await executeGit(root, ['config', 'user.name', 'Test'])
      await writeFile(join(root, 'note.txt'), 'contents\n', 'utf8')
      expect(await executeLocalGitMutation(root, ['add', '--', 'note.txt'])).toMatchObject({
        success: true
      })
      expect(await executeLocalGitMutation(root, ['commit', '-m', 'initial'])).toMatchObject({
        success: true
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects option-like references and paths outside the repository boundary', () => {
    expect(() => requireSafeGitReference('--upload-pack=x', 'branch name')).toThrow(
      'Invalid git branch name'
    )
    expect(() => requireSafeGitReference('HEAD..main', 'reference')).toThrow(
      'Invalid git reference'
    )
    expect(() => requireSafeGitPaths(['../secret'])).toThrow('Invalid git file path')
    expect(() => requireSafeGitPaths(['/absolute'])).toThrow('Invalid git file path')
    expect(requireSafeGitPaths(['src/index.ts', 'README.md'])).toEqual([
      'src/index.ts',
      'README.md'
    ])
  })
})
