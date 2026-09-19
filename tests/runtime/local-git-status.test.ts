import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalGitStatusTool } from '../../src/runtime/tools/local-git-status'

const execFileAsync = promisify(execFile)
const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('local git status tool', () => {
  it('uses a fixed, root-bound git command and reports untracked files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-git-root-'))
    cleanup.push(root)
    await execFileAsync('git', ['init', '--quiet'], { cwd: root })
    await writeFile(join(root, 'new.txt'), 'new')
    const tool = createLocalGitStatusTool(root)
    await expect(
      tool.execute({}, { signal: new AbortController().signal } as never)
    ).resolves.toContain('?? new.txt')
  })

  it('accepts no model-controlled command fields', () => {
    const tool = createLocalGitStatusTool('/workspace')
    expect(() => tool.validate({ command: 'status; rm -rf /' })).toThrow('INVALID_TOOL_INPUT')
  })
})
