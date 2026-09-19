import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeGit } from '../../src/runtime/host/git-executor'

describe('executeGit', () => {
  it('runs argument-array Git commands and returns structured failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-git-executor-'))
    try {
      await expect(executeGit(root, ['init'])).resolves.toMatchObject({
        success: true,
        exitCode: 0
      })
      await expect(executeGit(root, ['rev-parse', '--verify', 'missing'])).resolves.toMatchObject({
        success: false,
        exitCode: expect.any(Number),
        stderr: expect.any(String)
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
