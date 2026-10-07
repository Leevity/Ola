import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLocalFindFilesTool,
  createLocalGlobFilesTool
} from '../../src/runtime/tools/local-find-files'
import { skipWhenSymlinkUnavailable, tryCreateTestSymlink } from './symlink-fixture'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('local find and glob tools', () => {
  it('recursively finds bounded workspace files without traversing symlinks', async ({ skip }) => {
    const root = await mkdtemp(join(tmpdir(), 'ola-find-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'ola-find-outside-'))
    cleanup.push(root, outside)
    await Promise.all([mkdir(join(root, 'nested')), mkdir(join(root, 'node_modules'))])
    await Promise.all([
      writeFile(join(root, 'README.md'), ''),
      writeFile(join(root, 'nested', 'read-later.md'), ''),
      writeFile(join(root, 'node_modules', 'hidden.md'), ''),
      writeFile(join(outside, 'secret.md'), '')
    ])
    const linked = await tryCreateTestSymlink(outside, join(root, 'escape'), 'dir')
    skipWhenSymlinkUnavailable({ skip }, linked)

    const tool = createLocalFindFilesTool(root)
    await expect(
      tool.execute({ path: '.', query: 'read', limit: 10 }, {
        signal: new AbortController().signal
      } as never)
    ).resolves.toEqual([
      { path: 'nested/read-later.md', name: 'read-later.md' },
      { path: 'README.md', name: 'README.md' }
    ])
    await expect(tool.resources({ path: '../', query: '', limit: 1 }, {} as never)).rejects.toThrow(
      'TOOL_PATH_FORBIDDEN'
    )
  })

  it('uses bounded glob options and exposes truncation state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-glob-root-'))
    cleanup.push(root)
    await mkdir(join(root, 'nested'))
    await Promise.all([
      writeFile(join(root, 'root.ts'), ''),
      writeFile(join(root, '.hidden.ts'), ''),
      writeFile(join(root, 'nested', 'child.ts'), '')
    ])
    const resolvedRoot = await realpath(root)
    const tool = createLocalGlobFilesTool(root)
    const result = (await tool.execute(
      {
        path: '.',
        pattern: '**/*.ts',
        hidden: false,
        respectGitignore: true,
        limit: 10,
        maxDepth: null
      },
      { signal: new AbortController().signal } as never
    )) as { matches: unknown[]; truncated: boolean }
    expect(result.truncated).toBe(false)
    expect(result.matches).toHaveLength(2)
    expect(result.matches).toEqual(
      expect.arrayContaining([
        { path: join(resolvedRoot, 'nested', 'child.ts'), type: 'file' },
        { path: join(resolvedRoot, 'root.ts'), type: 'file' }
      ])
    )
    expect(() => tool.validate({ pattern: '*.ts', maxDepth: 51 })).toThrow('INVALID_TOOL_INPUT')
    expect(() => tool.validate({ pattern: '*.ts', extra: true })).toThrow('INVALID_TOOL_INPUT')
  })
})
